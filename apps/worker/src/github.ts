/**
 * GitHub App API client — port of `scripts/pr-queue-worker.py` lines 158-197
 * (`get_jwt` / `gh_api` / `get_installation_token`) and lines 599-606
 * (`_fetch_gh_token`).
 *
 * Two contract points that are easy to get wrong and are covered by tests:
 *
 * 1. RETRY SCOPE. `gh_api` retries TRANSPORT failures only (connect refused,
 *    reset connection, timeout, DNS). An HTTP 5xx is a *completed round trip*
 *    and is handed straight back to the caller as a 5xx status — retrying it
 *    would multiply the load on an already-struggling GitHub and would hide a
 *    real server error behind a silent success. Callers branch on the status.
 *
 * 2. `request` NEVER throws. After the attempts are exhausted it logs and
 *    returns status 0 with empty data, which every caller treats as failure
 *    (`if status != 200: return None` throughout the Python). A cron tick must
 *    degrade, not crash.
 */
import { createSign } from "node:crypto"
import { spawnSyncCompat } from "./lib/proc.ts"

/** Python `BASE_URL` (line 63) — overridden in tests to point at a fake server. */
const GITHUB_BASE_URL = "https://api.github.com"
/** Python `httpx.Client(timeout=30)` (line 171) — connect + read + write + pool. */
const TIMEOUT_MS = 30_000
/** Python `subprocess.run(..., timeout=10)` (line 603). */
const GH_CLI_TIMEOUT_MS = 10_000
/** Python `retries=3` (line 163) — three TOTAL attempts, not three retries. */
const DEFAULT_RETRIES = 3

/** Result of a completed HTTP round trip, or the `{0, {}}` failure sentinel. */
// biome-ignore lint/suspicious/noExplicitAny: verbatim from the pr_agent port
export type GhResult = { status: number; data: any }

export type RequestOpts = {
	/** When present, authenticates as `token <t>`; when absent, as `Bearer <jwt>`. */
	token?: string
	/** Request body, JSON-encoded. Omitted entirely when undefined (Python `json=None`). */
	json?: unknown
	/** Overrides the instance default. Total attempts, matching Python. */
	retries?: number
}

/** What `fetchGhToken` needs from a child process; keeps `gh` stubbable. */
export type SpawnResult = { exitCode: number | null; stdout: string }
export type Spawner = (argv: string[]) => SpawnResult

/**
 * RS256 JWT, no dependency: `base64url(header).base64url(payload)` signed with
 * node:crypto. Verbatim from the task brief, which in turn mirrors Python
 * lines 158-161 (`pyjwt.encode({iat: now-60, exp: now+600, iss: APP_ID}, key,
 * "RS256")`). The 60s backdate absorbs clock skew; the 600s life is GitHub's
 * maximum. Signing is cheap enough to do per call, which is what the Python did.
 */
export function signJwt(
	appId: string,
	privateKeyPem: string,
	nowSec = Math.floor(Date.now() / 1000),
): string {
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
	const head = b64({ alg: "RS256", typ: "JWT" })
	const body = b64({ iat: nowSec - 60, exp: nowSec + 600, iss: appId })
	const data = `${head}.${body}`
	const sig = createSign("RSA-SHA256").update(data).sign(privateKeyPem).toString("base64url")
	return `${data}.${sig}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Default `Spawner`: the real `gh` CLI, bounded like the Python's `timeout=10`. */
const spawnGh: Spawner = (argv) => {
	const r = spawnSyncCompat(argv, { timeout: GH_CLI_TIMEOUT_MS })
	return { exitCode: r.code, stdout: r.stdout }
}

export class GitHubApi {
	private readonly appId: string
	private readonly privateKeyPem: string
	private readonly baseUrl: string
	private readonly retries: number
	private readonly spawn: Spawner
	/**
	 * Cache for `fetchGhToken`, scoped to this instance rather than the module.
	 *
	 * DIVERGENCE FROM THE PYTHON (deliberate, brief-mandated): `_fetch_gh_token`
	 * re-runs `gh auth token` on all six of its call sites; this runs it at most
	 * once. The worker is a one-shot cron process — one process per tick — so
	 * the cache lives exactly one tick, and caching a PAT for that window is
	 * strictly less work with no behavioural difference. Instance scope (the
	 * run loop builds one `GitHubApi` per tick) is what makes it testable
	 * without a module-level reset hook, which would be a test-only export in
	 * production code.
	 *
	 * Only a SUCCESS is cached. A failed `gh` lookup returns "" and stays
	 * uncached, so a transient CLI failure can be retried later in the tick
	 * instead of poisoning it — matching the Python, which re-ran every time.
	 */
	private ghToken: string | undefined

	constructor(opts: {
		appId: string
		privateKeyPem: string
		baseUrl?: string
		retries?: number
		/** Injection seam for tests; production uses the real `gh` binary. */
		spawn?: Spawner
	}) {
		this.appId = opts.appId
		this.privateKeyPem = opts.privateKeyPem
		this.baseUrl = opts.baseUrl ?? GITHUB_BASE_URL
		this.retries = opts.retries ?? DEFAULT_RETRIES
		this.spawn = opts.spawn ?? spawnGh
	}

	/** Python `get_jwt()` (lines 158-161). Fresh signature per call. */
	jwt(): string {
		return signJwt(this.appId, this.privateKeyPem)
	}

	/**
	 * Python `gh_api(method, path, token, json_data, retries)` (lines 163-193).
	 *
	 * Each attempt issues a brand-new `fetch`, the Bun equivalent of Python's
	 * deliberate `httpx.Client()` per attempt: a fresh client re-resolves DNS, so
	 * a transient `EAI_AGAIN` clears on the next try instead of poisoning every
	 * later attempt through a pooled connection.
	 *
	 * Backoff is `2 ** attempt` seconds (1s, then 2s) — Python line 178.
	 */
	async request(method: string, path: string, opts: RequestOpts = {}): Promise<GhResult> {
		const retries = opts.retries ?? this.retries
		// Python line 165-166. The scheme is conditional: installation tokens use
		// `token`, the app JWT uses `Bearer`. GitHub rejects the wrong one.
		const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" }
		headers.Authorization = opts.token ? `token ${opts.token}` : `Bearer ${this.jwt()}`
		const body = opts.json === undefined ? undefined : JSON.stringify(opts.json)

		let lastError: unknown
		for (let attempt = 0; attempt < retries; attempt++) {
			try {
				const res = await fetch(`${this.baseUrl}${path}`, {
					method,
					headers,
					body,
					// Load-bearing: Bun's fetch has no default timeout, so without this
					// signal a hung connection would block the cron tick indefinitely.
					signal: AbortSignal.timeout(TIMEOUT_MS),
				})
				// Python lines 173-174: a completed round trip returns here whatever
				// the status; a body that will not parse becomes `{}`, not an error.
				//
				// A body that stops MID-STREAM is a different case, and the port has to
				// keep httpx's behaviour: httpx raises RemoteProtocolError, which the
				// Python catches as a transport failure and RETRIES. Bun's fetch has
				// already resolved by then and only rejects on the read, so treating
				// every read failure as "unparseable" would hand the caller a
				// `{status: 200, data: {}}` — a success carrying no data, which every
				// caller would then treat as a valid empty response. Distinguish the
				// two: a truncated/failed transfer rejects (retry), a body that is
				// genuinely not JSON returns `{}` (return, as Python does).
				// `res.text()` is read OUTSIDE the parse guard on purpose — a rejected
				// read must reach the transport catch below, not be swallowed here.
				const text = await res.text()
				try {
					return { status: res.status, data: JSON.parse(text) }
				} catch {
					return { status: res.status, data: {} }
				}
			} catch (e) {
				// Python lines 175-191. httpx distinguishes its transport errors and
				// then falls through to a catch-all; in Bun there is one rejection
				// channel, so this single catch is the union of all three handlers.
				lastError = e
				if (attempt < retries - 1) {
					await sleep(2 ** attempt * 1000)
				}
			}
		}
		// Python line 192-193: log, then return the failure sentinel. stderr rather
		// than stdout because this is a failure, and the buffered Discord report
		// (report.ts) is a separate channel that must not be polluted with it.
		console.error(`[gh_api] connect failed after ${retries} attempts: ${lastError}`)
		return { status: 0, data: {} }
	}

	/**
	 * Python `get_installation_token(inst_id)` (lines 195-197). Called WITHOUT a
	 * token, so this is a JWT-authenticated call. No caching and no expiry
	 * tracking, exactly as the Python: installation tokens live one hour and the
	 * worker holds a tick, not a day.
	 */
	async installationToken(installId: number): Promise<string> {
		const { data } = await this.request("POST", `/app/installations/${installId}/access_tokens`)
		return data?.token ?? ""
	}

	/**
	 * Python `_fetch_gh_token()` (lines 599-606). `gh auth token` is a local,
	 * already-authenticated read of the stored PAT — no GitHub round trip — so a
	 * failure degrades to "" and never throws.
	 */
	fetchGhToken(): string {
		if (this.ghToken !== undefined) return this.ghToken
		let token = ""
		try {
			const r = this.spawn(["gh", "auth", "token"])
			if (r.exitCode === 0) token = r.stdout.trim()
		} catch {
			/* Python line 605-606: a missing or broken gh CLI must not crash the tick */
		}
		if (token) this.ghToken = token
		return token
	}
}

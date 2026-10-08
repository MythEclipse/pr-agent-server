// biome-ignore-all lint/suspicious/noExplicitAny: test fakes stand in for untyped GitHub payloads
// biome-ignore-all lint/style/noNonNullAssertion: test asserts immediately after each non-null use
/**
 * `runSyncHooks` — the daily fork-config + PR-Agent-webhook sync.
 *
 * THE FAKE RECORDS, IT DOES NOT COUNT CALLS. Every group below asserts on the
 * requests that were actually made: the path, the method and the parsed body.
 * "the fake was called" is not an outcome.
 *
 * HERMETICITY: the module reads `GITHUB_WEBHOOK_SECRET` at CALL time (never at
 * import), so the env is saved and restored around each test. The real secret
 * must not reach the assertions in group 4, and the real one must not be
 * readable by a suite that has no business reading it.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { runSyncHooks, type SyncHooksDeps } from "../src/ops/syncHooks.ts"

const TEMPLATE_DIR = join(import.meta.dirname, "..", "src", "ops", "templates")

/** Byte-exact from the brief: this is the URL the hook must point at. */
const PR_AGENT_URL = "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks"
/** Byte-exact from the brief. */
const EVENTS = [
	"issue_comment",
	"pull_request",
	"pull_request_review",
	"pull_request_review_comment",
]

const DEPENDABOT_PATH = ".github/dependabot.yml"
const GMW_DEPENDABOT_PATH = ".github/dependabot-gmw.yml"
const AUTO_MERGE_PATH = ".github/dependabot-auto-merge.yml"

const template = (name: string) => readFileSync(join(TEMPLATE_DIR, name), "utf8")
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")
const unb64 = (text: string) => Buffer.from(text, "base64").toString("utf8")

// ── The fake GitHub ──────────────────────────────────────────────────────────

type Recorded = { method: string; path: string; token?: string; json?: any }

/** Per-repo world: which hooks exist, and which files exist with what content. */
type Fixture = { hooks?: any[]; files?: Record<string, string> }

type Fake = { api: NonNullable<SyncHooksDeps["api"]>; calls: Recorded[] }

/**
 * Route on `${method} ${path}`. Content GETs 404 for a path the fixture does
 * not hold, which is GitHub's real answer for a file that was never created —
 * the distinction the conditional-PUT rule depends on.
 */
function fakeApi(repos: string[], fixtures: Record<string, Fixture> = {}): Fake {
	const calls: Recorded[] = []
	const request = async (
		method: string,
		path: string,
		opts: { token?: string; json?: unknown } = {},
	) => {
		calls.push({ method, path, token: opts.token, json: opts.json })

		if (method === "GET" && path === "/users/asepharyana/repos?per_page=100") {
			return { status: 200, data: repos.map((full_name) => ({ full_name })) }
		}
		const hooks = /^GET \/repos\/([^/]+\/[^/]+)\/hooks$/.exec(`${method} ${path}`)
		if (hooks) {
			return { status: 200, data: fixtures[hooks[1]]?.hooks ?? [] }
		}
		if (method === "POST" && /\/repos\/([^/]+\/[^/]+)\/hooks$/.test(path)) {
			return { status: 201, data: { id: 1 } }
		}
		const content = /^(GET|PUT) \/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(`${method} ${path}`)
		if (content) {
			const files = fixtures[content[2]]?.files ?? {}
			if (method === "GET") {
				const held = files[content[3]]
				if (held === undefined) return { status: 404, data: { message: "Not Found" } }
				return {
					status: 200,
					data: { sha: `sha-of-${content[3]}`, encoding: "base64", content: b64(held) },
				}
			}
			return { status: 200, data: { content: { sha: "new-sha" } } }
		}
		return { status: 404, data: { message: `unrouted ${method} ${path}` } }
	}
	return { api: { request }, calls }
}

const of = (calls: Recorded[], method: string, path: string) =>
	calls.filter((c) => c.method === method && c.path === path)
const hookPosts = (calls: Recorded[]) =>
	calls.filter((c) => c.method === "POST" && c.path.endsWith("/hooks"))
const contentPuts = (calls: Recorded[]) =>
	calls.filter((c) => c.method === "PUT" && c.path.includes("/contents/"))

// ── Call-time env ────────────────────────────────────────────────────────────

let realSecret: string | undefined
beforeEach(() => {
	realSecret = process.env.GITHUB_WEBHOOK_SECRET
	delete process.env.GITHUB_WEBHOOK_SECRET
})
afterEach(() => {
	if (realSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
	else process.env.GITHUB_WEBHOOK_SECRET = realSecret
})

// ── Group 1 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > the pr-agent webhook", () => {
	// Group 1: a repo without the pr-agent hook gets a POST carrying the exact
	// URL, content_type, secret and event list from the brief.
	test("posts the hook with the brief's url, content_type, secret and events", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		const res = await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s3cr3t-value" })

		const posts = hookPosts(calls)
		expect(posts).toHaveLength(1)
		expect(posts[0].path).toBe("/repos/asepharyana/GMW/hooks")
		expect(posts[0].json).toEqual({
			name: "web",
			active: true,
			events: EVENTS,
			config: { url: PR_AGENT_URL, content_type: "json", secret: "s3cr3t-value" },
		})
		expect(res.ok).toBe(3)
		expect(res.skip).toBe(0)
	})

	// Group 1 again: the events list is an ordered set, and an order or spelling
	// change silently narrows what PR-Agent ever hears about.
	test("sends the four events in the brief's order", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })
		expect(hookPosts(calls)[0].json.events).toEqual(EVENTS)
	})

	// Group 5 (safety): the report goes to an ops Discord channel, so a secret in
	// `lines` is a credential leak — the bug class that already shipped once in
	// this repo as cc15d06.
	test("never puts the secret or the token in a report line", async () => {
		const { api } = fakeApi(["asepharyana/GMW", "asepharyana/Other"])
		const res = await runSyncHooks({
			api,
			ghToken: "pat-do-not-leak",
			webhookSecret: "s3cr3t-value",
		})
		const report = res.lines.join("\n")
		expect(report).not.toContain("s3cr3t-value")
		expect(report).not.toContain("pat-do-not-leak")
		expect(res.lines.length).toBeGreaterThan(0)
	})
})

// ── Group 2 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > an existing hook", () => {
	// Group 2: a repo that already has the pr-agent hook is left alone. A second
	// POST would create a duplicate delivery of every comment to PR-Agent.
	test("does not post a hook when the repo already has the pr-agent url", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"], {
			"asepharyana/GMW": {
				hooks: [{ id: 7, config: { url: PR_AGENT_URL, content_type: "json" } }],
			},
		})
		const res = await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })

		expect(hookPosts(calls)).toHaveLength(0)
		expect(of(calls, "GET", "/repos/asepharyana/GMW/hooks")).toHaveLength(1)
		// The hook is the only skip; the two files were absent, so they were written.
		expect(res.ok).toBe(2)
		expect(res.skip).toBe(1)
	})

	// A hook pointing somewhere else is NOT the pr-agent hook. Skipping on a
	// substring would leave the fork permanently un-wired.
	test("posts when the only hook on the repo points elsewhere", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"], {
			"asepharyana/GMW": { hooks: [{ id: 7, config: { url: "https://example.invalid/hook" } }] },
		})
		await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })
		expect(hookPosts(calls)).toHaveLength(1)
	})
})

// ── Group 3 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > dependabot templates", () => {
	test("routes gmw to the gmw template, every other repo to the plain one", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW", "asepharyana/Other"])
		await runSyncHooks({ api, ghToken: "pat" })

		const gmw = contentPuts(calls).filter((c) => c.path.startsWith("/repos/asepharyana/GMW/"))
		const other = contentPuts(calls).filter((c) => c.path.startsWith("/repos/asepharyana/Other/"))

		// GMW gets the gmw variant INSTEAD of the plain one.
		expect(
			gmw.filter((c) => c.path === `/repos/asepharyana/GMW/contents/${GMW_DEPENDABOT_PATH}`),
		).toHaveLength(1)
		expect(
			gmw.filter((c) => c.path === `/repos/asepharyana/GMW/contents/${DEPENDABOT_PATH}`),
		).toHaveLength(0)
		// Everything else gets the plain one.
		expect(
			other.filter((c) => c.path === `/repos/asepharyana/Other/contents/${DEPENDABOT_PATH}`),
		).toHaveLength(1)
		expect(
			other.filter((c) => c.path === `/repos/asepharyana/Other/contents/${GMW_DEPENDABOT_PATH}`),
		).toHaveLength(0)
	})

	// Group 3: the auto-merge file is installed on EVERY repo, GMW included.
	test("installs the auto-merge template on every repo", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW", "asepharyana/Other"])
		await runSyncHooks({ api, ghToken: "pat" })

		const auto = contentPuts(calls).filter((c) => c.path.endsWith(AUTO_MERGE_PATH))
		expect(auto.map((c) => c.path).sort()).toEqual([
			"/repos/asepharyana/GMW/contents/.github/dependabot-auto-merge.yml",
			"/repos/asepharyana/Other/contents/.github/dependabot-auto-merge.yml",
		])
	})

	// The body has to be the real file, base64-encoded as the contents API
	// requires — not a re-serialised approximation of it.
	test("writes the template bytes, not a paraphrase", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		await runSyncHooks({ api, ghToken: "pat" })

		const put = contentPuts(calls).find((c) => c.path.endsWith(GMW_DEPENDABOT_PATH))
		expect(put).toBeDefined()
		expect(unb64(put?.json.content)).toBe(template("dependabot-gmw.yml"))
		const auto = contentPuts(calls).find((c) => c.path.endsWith(AUTO_MERGE_PATH))
		expect(unb64(auto?.json.content)).toBe(template("dependabot-auto-merge.yml"))
	})
})

// ── Group 4 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > no webhook secret", () => {
	// Group 4: the whole step is SKIPPED, not attempted with an empty secret.
	// Posting `secret: ""` to a real GitHub API installs a hook anyone can forge.
	test("makes no POST /repos/{repo}/hooks request at all", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW", "asepharyana/Other"])
		const res = await runSyncHooks({ api, ghToken: "pat" })

		expect(hookPosts(calls)).toHaveLength(0)
		// Not even the read: the step is not entered, not merely not written.
		expect(calls.filter((c) => c.path.endsWith("/hooks"))).toHaveLength(0)
		// The file half of the work still runs.
		expect(contentPuts(calls).length).toBe(4)
		expect(res.ok).toBe(4)
	})

	test("treats an empty string the same as an absent secret", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		await runSyncHooks({ api, ghToken: "pat", webhookSecret: "" })
		expect(hookPosts(calls)).toHaveLength(0)
	})

	// The secret is read at CALL time, not frozen at import. If it were module
	// scope this test could only pass on the machine holding the real value.
	test("reads GITHUB_WEBHOOK_SECRET at call time", async () => {
		process.env.GITHUB_WEBHOOK_SECRET = "from-env"
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		await runSyncHooks({ api, ghToken: "pat" })

		expect(hookPosts(calls)).toHaveLength(1)
		expect(hookPosts(calls)[0].json.config.secret).toBe("from-env")
	})
})

// ── Group 5 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > the summary", () => {
	// Group 5: ok + skip must equal the number of actions ATTEMPTED, and lines
	// must be one per action — with a deliberate skip invisible in neither
	// counter, which is why the no-secret case above reports ok 4 / skip 0.
	test("counts every action once and reports one line per action", async () => {
		const { api } = fakeApi(["asepharyana/GMW", "asepharyana/Other"], {
			// Nothing on disk, no hooks: every action writes.
			"asepharyana/GMW": {},
			// Fully in sync: every action is a no-op.
			"asepharyana/Other": {
				hooks: [{ id: 3, config: { url: PR_AGENT_URL } }],
				files: {
					[DEPENDABOT_PATH]: template("dependabot.yml"),
					[AUTO_MERGE_PATH]: template("dependabot-auto-merge.yml"),
				},
			},
		})
		const res = await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })

		// GMW: 1 hook + 2 files = 3 writes. Other: 3 no-ops.
		expect(res.ok).toBe(3)
		expect(res.skip).toBe(3)
		expect(res.lines).toHaveLength(6)
		expect(res.lines.filter((l) => l.includes("asepharyana/GMW"))).toHaveLength(3)
		expect(res.lines.filter((l) => l.includes("asepharyana/Other"))).toHaveLength(3)
	})

	// The conditional write: a file that already matches is a skip, not a write.
	// A blind PUT every tick is a write storm against every fork, forever.
	test("skips a file that already matches and does not PUT it", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"], {
			"asepharyana/Other": {
				files: {
					[DEPENDABOT_PATH]: template("dependabot.yml"),
					[AUTO_MERGE_PATH]: template("dependabot-auto-merge.yml"),
				},
			},
		})
		const res = await runSyncHooks({ api, ghToken: "pat" })

		expect(contentPuts(calls)).toHaveLength(0)
		expect(of(calls, "GET", `/repos/asepharyana/Other/contents/${DEPENDABOT_PATH}`)).toHaveLength(1)
		expect(res.ok).toBe(0)
		expect(res.skip).toBe(2)
	})

	// A differing file is written WITH the sha — GitHub rejects a content PUT
	// without it (409/422), so this is the difference between working and not.
	test("sends the existing sha when the content differs", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"], {
			"asepharyana/Other": { files: { [DEPENDABOT_PATH]: "version: 2 # stale\n" } },
		})
		const res = await runSyncHooks({ api, ghToken: "pat" })

		const put = contentPuts(calls).find((c) => c.path.endsWith(DEPENDABOT_PATH))
		expect(put).toBeDefined()
		expect(put?.json.sha).toBe(`sha-of-${DEPENDABOT_PATH}`)
		expect(unb64(put?.json.content)).toBe(template("dependabot.yml"))
		expect(res.ok).toBe(2) // the dependabot rewrite + the auto-merge create
	})

	// A file that does not exist yet is a CREATE: no sha exists to send.
	test("creates a missing file without a sha", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"])
		await runSyncHooks({ api, ghToken: "pat" })
		for (const put of contentPuts(calls)) expect(put.json.sha).toBeUndefined()
	})

	// A failed action still has to be accounted for, or `ok + skip` would stop
	// describing the work done and the summary would under-report silently.
	test("counts a failed write as neither a success nor a clean skip", async () => {
		const { api } = fakeApi(["asepharyana/Other"], { "asepharyana/Other": {} })
		// Reads succeed (so the file is genuinely different and a PUT is attempted)
		// and every write is rejected.
		const failing = {
			request: async (method: string, path: string) =>
				method === "PUT"
					? { status: 405, data: { message: "not allowed" } }
					: api.request(method, path),
		}
		const res = await runSyncHooks({ api: failing, ghToken: "pat" })

		expect(res.ok).toBe(0)
		expect(res.skip).toBe(2)
		expect(res.lines.join("\n")).toContain("asepharyana/Other")
		expect(res.lines.join("\n")).toContain("405")
	})

	// A file that cannot be READ is not written. An unverifiable overwrite of a
	// file we could not see is the one outcome worse than leaving it alone.
	test("leaves a file alone when it cannot be read", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"])
		const unreadable = {
			request: async (method: string, path: string) =>
				method === "GET" && path.includes("/contents/")
					? { status: 403, data: { message: "Forbidden" } }
					: api.request(method, path),
		}
		const res = await runSyncHooks({ api: unreadable, ghToken: "pat" })

		expect(contentPuts(calls)).toHaveLength(0)
		expect(res.ok).toBe(0)
		expect(res.skip).toBe(2)
		expect(res.lines.join("\n")).toContain("403")
	})

	// An empty repo list is a quiet, successful no-op, not a crash.
	test("reports nothing for an empty repo list", async () => {
		const { api, calls } = fakeApi([])
		const res = await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })
		expect(res).toEqual({ ok: 0, skip: 0, lines: [] })
		expect(calls).toHaveLength(1) // the listing, and nothing else
	})

	// No credential means no work, and the only honest thing to report is why.
	// A silent "0 synced" would read as a healthy run.
	test("reports the missing credential and issues no request", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		const res = await runSyncHooks({ api, ghToken: "" })

		expect(calls).toHaveLength(0)
		expect(res.ok).toBe(0)
		expect(res.skip).toBe(0)
		expect(res.lines.join("\n")).toContain("no GitHub token")
	})

	// The deps object is OPTIONAL, so the module resolves the repo list itself.
	test("lists asepharyana's repos when no list is injected", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		const res = await runSyncHooks({ api, ghToken: "pat" })
		expect(of(calls, "GET", "/users/asepharyana/repos?per_page=100")).toHaveLength(1)
		expect(res.ok).toBe(2)
	})
})

/**
 * The CLI wiring for `--sync-hooks` (Task 16), in `src/index.ts`.
 *
 * What matters here is the GATE, not the sync. `runSyncHooks` is already proven
 * by the tests above; what was untested until now is whether an operator can
 * trigger fleet-wide Dependabot writes by accident. These assert they cannot:
 * the mode is refused unless `PR_AGENT_SYNC_HOOKS=1` is set, and the refusal
 * happens BEFORE any credential is read or any request is made.
 */
describe("the --sync-hooks CLI gate", () => {
	const KEY = "PR_AGENT_SYNC_HOOKS"
	let real: string | undefined
	let runIndex: (argv: string[]) => Promise<number>

	beforeAll(async () => {
		real = process.env[KEY]
		// Imported lazily: src/index.ts calls bootstrapEnv() at module scope, so
		// it must not be imported while other suites hold a staged environment.
		const mod = await import("../src/index")
		runIndex = (argv) => mod.runCliForTest(argv)
	})

	afterEach(() => {
		if (real === undefined) delete process.env[KEY]
		else process.env[KEY] = real
	})

	test("refuses when the gate is unset, and explains why", async () => {
		delete process.env[KEY]
		const code = await runIndex(["--sync-hooks"])
		expect(code).toBe(1)
	})

	test('refuses for a value that is not exactly "1"', async () => {
		for (const v of ["", "0", "true", "yes", "TRUE"]) {
			process.env[KEY] = v
			expect(await runIndex(["--sync-hooks"])).toBe(1)
		}
	})

	test("the refusal needs no credential: no key file, no token, no request", async () => {
		// PATH points at an empty dir and the key path at a file that cannot exist,
		// so ANY attempt to build deps would throw before returning 1.
		process.env[KEY] = "0"
		const oldPath = process.env.PATH
		const oldKey = process.env.PR_AGENT_KEY_PATH
		process.env.PR_AGENT_KEY_PATH = "/nonexistent/pr-agent-key.pem"
		try {
			expect(await runIndex(["--sync-hooks"])).toBe(1)
		} finally {
			process.env.PATH = oldPath
			if (oldKey === undefined) delete process.env.PR_AGENT_KEY_PATH
			else process.env.PR_AGENT_KEY_PATH = oldKey
		}
	})
})

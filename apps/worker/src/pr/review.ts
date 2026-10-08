// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code / test fixtures use untyped JSON shapes
/**
 * PR-Agent trigger + review-comment detection — port of
 * `scripts/pr-queue-worker.py` lines 320-330 (`find_review_comment`),
 * 333-348 (`find_trivial_noreview_marker`) and 410-453
 * (`trigger_pr_agent_review`), plus `BOT_LOGIN` from line 64.
 *
 * THE PR-AGENT TRIGGER IS THE INTERESTING PART. PR-Agent normally learns about
 * a PR from a GitHub webhook. Here the worker is the one that notices the PR
 * (it polls), so it has to FABRICATE the webhook itself: build a synthetic
 * `pull_request` event body, sign it with the shared secret exactly as GitHub
 * would, and POST it to the server. The server is a real HMAC-verifying
 * endpoint (server/src/http/webhook.ts), so a wrong signature is a 403.
 *
 * WHY THE PAYLOAD MUST BE COMPLETE (Python lines 412-414, and the single most
 * important comment in this port): PR-Agent's `_check_pull_request_event`
 * requires `pull_request.url`. Without it the server returns HTTP 200 and then
 * rejects the event internally with
 * `Invalid PR event: action='opened' api_url=''` — and NO REVIEW RUNS. The
 * failure is silent: the worker would report "triggered (HTTP 200)" every five
 * minutes forever and the PR would never be reviewed. Real GitHub webhooks
 * also carry `state`, `draft`, `labels` and `installation.id` (which feeds the
 * installation-token lookup), so the synthetic body carries all of them.
 *
 * The signature is computed over the EXACT bytes that are sent. The payload is
 * therefore serialised ONCE, that string is both signed and POSTed, and no
 * re-serialisation happens anywhere between the two. Serialising twice would
 * risk a key-order difference producing a different byte string, which verifies
 * as an invalid signature.
 */
import { createHmac } from "node:crypto"
import type { GhAppClient, GhClient } from "./scan.ts"

/** Python `BOT_LOGIN` (line 64). */
export const BOT_LOGIN = "mytheclipsebotreview"

/** Python `WEBHOOK_SECRET` default (line 61) — empty, never a real secret. */
export const DEFAULT_WEBHOOK_SECRET = ""
/** Python `PR_AGENT_WEBHOOK_URL` default (line 62). */
export const DEFAULT_WEBHOOK_URL = "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks"
/** Python `httpx.Client(timeout=30)` (line 446) for the webhook POST. */
const WEBHOOK_TIMEOUT_MS = 30_000

/** Injection seam: the `fetch` used for the webhook POST. */
export type FetchLike = (
	input: string,
	init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>

/**
 * Everything the trigger needs from the environment, INJECTED.
 *
 * DELIBERATE, and the lesson from the Task 8 review: these are resolved at CALL
 * time by the caller (the CLI wiring in Task 14), never at module scope. Bun
 * snapshots `homedir()` at process start, so a module-scope read of a secret
 * path made a test suite pass only on the machine that happened to hold the
 * real secret. The CLI wiring is also the right place for it: a module that
 * reads `process.env` at import is untestable in isolation.
 */
export type TriggerDeps = {
	/** Used for the best-effort installation-id lookup. */
	api: GhAppClient
	fetchImpl: FetchLike
	/** `PR_AGENT_WEBHOOK_SECRET`. Empty string signs with the empty key. */
	webhookSecret?: string
	/** `PR_AGENT_WEBHOOK_URL`. */
	webhookUrl?: string
	/** Unix seconds for `x-github-delivery`. Defaults to the wall clock. */
	nowSec?: number
}

/** Python's return: an int status, or `f"error: {e}"` (line 453). */
export type TriggerResult = number | string

/** One issue comment, as far as this module reads it. */
const loginOf = (c: any): string => (typeof c?.user?.login === "string" ? c.user.login : "")
const bodyOf = (c: any): string => (typeof c?.body === "string" ? c.body : "")

/** The bot's review body for `pr`, or null. Python lines 320-330. */
export async function findReviewComment(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
): Promise<string | null> {
	const { data: comments } = await api.request("GET", `/repos/${repo}/issues/${pr}/comments`, {
		token,
	})
	if (!Array.isArray(comments)) return null // Python lines 322-323
	for (const c of comments) {
		// SUBSTRING test, as Python line 326: GitHub's App login is
		// `mytheclipsebotreview[bot]`, so equality against the bare login would
		// never match. NOT `in`: JavaScript's `in` is the property-existence
		// operator and THROWS a TypeError on a string primitive, where Python's
		// `in` is a substring test. `includes` is the equivalent.
		if (loginOf(c).includes(BOT_LOGIN)) {
			const body = bodyOf(c)
			if (body.includes("PR Reviewer Guide")) return body
		}
	}
	return null
}

/**
 * Python `find_trivial_noreview_marker` (lines 333-348).
 *
 * TRUE if PR-Agent already decided this PR has no code diff to review (e.g. a
 * dependabot lockfile-only bump). Such a PR never produces a "PR Reviewer
 * Guide"; it gets "PR Code Suggestions: No code suggestions found" instead.
 * Returning true lets the worker treat it as reviewed and skip re-triggering
 * every 5 minutes — the bug that produced duplicate comment spam on GMW #22
 * on 2026-08-28.
 *
 * BOTH markers are required, and the PAIR is what distinguishes "nothing to
 * review" from "the reviewer ran and found nothing to fix"; a comment
 * containing only the heading is a review in progress, not a verdict.
 */
export async function findTrivialNoReviewMarker(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
): Promise<boolean> {
	const { data: comments } = await api.request("GET", `/repos/${repo}/issues/${pr}/comments`, {
		token,
	})
	if (!Array.isArray(comments)) return false // Python lines 340-341
	for (const c of comments) {
		if (loginOf(c).includes(BOT_LOGIN)) {
			const body = bodyOf(c)
			if (body.includes("PR Code Suggestions") && body.includes("No code suggestions found")) {
				return true
			}
		}
	}
	return false
}

/**
 * Best-effort installation id for `repo` — Python lines 418-430.
 *
 * Walks every installation's repository list looking for the repo. It is
 * best-effort in the Python too, and that matters more than it looks: a wrong
 * or missing `installation.id` costs PR-Agent its installation token, so the
 * review is degraded, whereas a RAISED exception would abort the tick. Any
 * failure here means id 0, and the webhook is still sent.
 */
async function resolveInstallId(api: GhAppClient, repo: string): Promise<number> {
	try {
		const { data: installs } = await api.request("GET", "/app/installations")
		if (!Array.isArray(installs)) return 0
		for (const inst of installs) {
			const id = (inst as { id?: number })?.id
			if (typeof id !== "number") continue
			const token = await api.installationToken(id)
			const { data: repos } = await api.request("GET", "/installation/repositories?per_page=100", {
				token,
			})
			// Python line 425 guards the dict before `.get`, and filters non-dict
			// entries; both are reproduced so a malformed entry cannot throw here.
			const list =
				repos !== null && typeof repos === "object" && Array.isArray((repos as any).repositories)
					? (repos as any).repositories
					: []
			const fulls = (list as any[])
				.filter((r: any) => r !== null && typeof r === "object")
				.map((r: any) => r.full_name)
			if (fulls.includes(repo)) return id
		}
	} catch {
		return 0 // Python lines 429-430
	}
	return 0
}

/**
 * Python `trigger_pr_agent_review(repo_full, pr_num, title, head_sha, head_ref,
 * base_ref)` (lines 410-453).
 *
 * Returns the HTTP status number, or `error: <message>` if the POST itself
 * failed (line 453). A non-2xx status is returned VERBATIM and the caller
 * judges it (Python line 1928 treats 2xx as success, anything else as a report
 * line) — swallowing a 403 here would turn "signature is wrong" into a silent
 * no-review, which is the exact failure this function exists to avoid.
 */
export async function triggerReview(
	deps: TriggerDeps,
	repo: string,
	pr: number,
	title: string,
	headSha: string,
	headRef: string,
	baseRef: string,
): Promise<TriggerResult> {
	const installId = await resolveInstallId(deps.api, repo)

	// Key order is the Python's (lines 431-443).
	//
	// NOT byte-identical to the Python's `json.dumps`: that call uses the default
	// separators (", " and ": "), while `JSON.stringify` emits "," and ":". The
	// server parses the body as JSON, so this is a PARSE-equivalent difference,
	// not a behavioural one — the same judgement state.ts records for the fix
	// state file. What IS load-bearing is that the signature below is computed
	// over THIS string and the same string is POSTed, so the two can never
	// disagree; the receiver verifies bytes against the bytes it received, not
	// against a re-serialisation of them.
	const payload = JSON.stringify({
		action: "opened",
		number: pr,
		sender: { login: "mytheclipsebotreview", id: 0, type: "Bot" },
		installation: { id: installId },
		pull_request: {
			url: `https://api.github.com/repos/${repo}/pulls/${pr}`,
			number: pr,
			title,
			state: "open",
			draft: false,
			labels: [],
			head: { sha: headSha, ref: headRef },
			base: { ref: baseRef, repo: { full_name: repo } },
		},
		repository: { full_name: repo },
	})

	// Python line 444. Signed over the SAME string that is sent below.
	const secret = deps.webhookSecret ?? DEFAULT_WEBHOOK_SECRET
	const sig = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`
	const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000)

	try {
		const r = await deps.fetchImpl(deps.webhookUrl ?? DEFAULT_WEBHOOK_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-github-event": "pull_request",
				"x-hub-signature-256": sig,
				"x-github-delivery": `cron-${nowSec}-${pr}`,
			},
			body: payload,
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		})
		return r.status
	} catch (e) {
		return `error: ${e instanceof Error ? e.message : String(e)}` // line 453
	}
}

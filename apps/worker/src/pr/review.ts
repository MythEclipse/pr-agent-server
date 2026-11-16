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
 * endpoint (apps/api/src/application/webhook/), so a wrong signature is a 403.
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

/**
 * Page size for the issue-comment walk. GitHub's default is 30, which is smaller
 * than a busy PR's comment list — see `findReviewComment`.
 */
const COMMENT_PAGE_SIZE = 100

/**
 * Hard stop for that walk. 30 pages is 3000 comments — GitHub's own ceiling for
 * a PR's issue comments — and, more importantly, a bound: a proxy or a stub that
 * ignores `?page=` answers a full page forever, and this loop used to be
 * `for (;;)` with no cap. `findReviewComment` runs on every PR on every tick, so
 * the failure mode was not a slow tick but a WEDGED worker. Every other
 * paginator here is bounded for the same reason.
 */
const MAX_COMMENT_PAGES = 30

/**
 * Every issue comment on `pr`, oldest first, walking pages until a short one.
 *
 * A malformed (non-array) page ends the walk with whatever was collected, which
 * reproduces the old "a non-array response is not a review" behaviour for the
 * first page without discarding pages already read.
 */
async function listAllComments(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
): Promise<any[]> {
	const all: any[] = []
	for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
		const { data } = await api.request(
			"GET",
			`/repos/${repo}/issues/${pr}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
			{ token },
		)
		if (!Array.isArray(data)) break
		all.push(...data)
		if (data.length < COMMENT_PAGE_SIZE) break
	}
	return all
}

/**
 * The commit a review comment claims to have reviewed, or null.
 *
 * The publisher writes `#### (Review updated until commit <sha>)` right under the
 * guide header (`publishPersistentComment`; the non-persistent path appends the
 * same line). The value is the head SHA, but a commit URL is accepted too
 * because the marker is named "commit" and the two spellings have both existed.
 * A `Describe updated until commit …` marker matches as well — the leading word
 * is whatever the tool is called, and only the SHA is load-bearing.
 */
const REVIEW_HEADER_RE = /#{2,4}\s*\(\s*(?:[A-Za-z]+\s+)?updated until commit\s+([^)\s]+)\s*\)/i
const SHA_TAIL_RE = /([0-9a-f]{7,40})\s*$/i

export function reviewHeadShaOf(body: string): string | null {
	const marker = REVIEW_HEADER_RE.exec(body)
	if (!marker) return null
	// A commit URL is accepted (the marker is named "commit"), and a URL may carry
	// a query or fragment — `…/commit/<sha>?diff=split`. The SHA is the tail of
	// the PATH, so anything after `?`/`#` is not part of the identity.
	const value = marker[1].replace(/[?#].*$/, "")
	const tail = SHA_TAIL_RE.exec(value)
	return tail ? tail[1].toLowerCase() : null
}

/**
 * Does the recorded SHA name the same commit as `headSha`?
 *
 * Prefix comparison in BOTH directions: GitHub shortens SHAs in prose (7-12
 * characters) while the API reports 40, so neither form is guaranteed to be the
 * longer one. A mismatch of fewer than 7 characters is not treated as a match —
 * GitHub's own minimum abbreviation is 7, and a 4-character prefix is a
 * collision risk rather than an identification.
 */
const shaNamesCommit = (recorded: string, headSha: string): boolean => {
	const a = recorded.toLowerCase()
	const b = headSha.toLowerCase()
	if (!a || !b) return false
	if (a === b) return true
	const shorter = a.length <= b.length ? a : b
	const longer = a.length <= b.length ? b : a
	return shorter.length >= 7 && longer.startsWith(shorter)
}

/**
 * The bot's review body for `pr` AT `headSha`, or null. Python lines 320-330,
 * hardened.
 *
 * SCAN FORWARD, DO NOT STOP AT THE FIRST MATCHING AUTHOR. This used to return
 * the first bot comment that contained the guide, and the worker runs every
 * five minutes on the SAME PR, so that decision is made again and again while
 * the PR moves. `publishPersistentComment` edits the one comment whose body
 * STARTS WITH the header and then posts a small "**[Persistent review]** updated
 * to latest commit" comment under bot authorship — so on every re-review the
 * FIRST bot comment carrying the guide is the SUPERSEDED one, and the worker
 * scored a review that had already been replaced. hub#61 lived this: its body
 * said `🔒 Security concerns / Yes - TLS certificate trust issue` from an early
 * run, a later run rewrote it to `No security concerns identified`, and the
 * worker kept parsing the stale copy and blocking at 0/10 for ten ticks.
 *
 * THE COMMENT MUST NAME THE COMMIT IT REVIEWED, and that commit must be the
 * head being processed. Scanning for the latest guide alone was not enough: a
 * review published for commit A stayed the "latest" review after the author
 * pushed commit B, so the worker scored A's diff, approved it, and could merge
 * B on the strength of it. The publisher stamps
 * `#### (Review updated until commit <sha>)` on every review it writes
 * (`publishPersistentComment`, and the non-persistent path), so the claim is
 * checkable; a review that does not name a commit is not evidence about this
 * one. Rejecting it re-triggers a review, which edits the same comment in place
 * and stamps the marker — so a legacy markerless comment self-heals on the next
 * tick instead of being trusted forever.
 *
 * The scan walks EVERY page of issue comments. It used to read GitHub's default
 * first page (30 comments) oldest-first, so on a busy PR the newest review was
 * simply not in the response and the worker re-triggered — or, worse, matched an
 * old review from the visible prefix.
 */
export async function findReviewComment(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
	headSha: string,
): Promise<string | null> {
	const comments = await listAllComments(api, token, repo, pr)
	let found: string | null = null
	for (const c of comments) {
		// SUBSTRING test, as Python line 326: GitHub's App login is
		// `mytheclipsebotreview[bot]`, so equality against the bare login would
		// never match. NOT `in`: JavaScript's `in` is the property-existence
		// operator and THROWS a TypeError on a string primitive, where Python's
		// `in` is a substring test. `includes` is the equivalent.
		if (loginOf(c).includes(BOT_LOGIN)) {
			const body = bodyOf(c)
			if (!body.includes("PR Reviewer Guide")) continue
			const reviewed = reviewHeadShaOf(body)
			// No marker, or a marker naming another commit: this is not a review
			// of the head being processed. Keep scanning — a later comment may be.
			if (!reviewed || !shaNamesCommit(reviewed, headSha)) continue
			found = body
		}
	}
	return found
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
 *
 * KNOWN RESIDUAL RISK: unlike a guide, this marker carries no commit, so it
 * cannot be tied to the head being processed. It is only consulted for a PR the
 * worker already classified as trivial from its TITLE and author, and such a PR
 * that has gained a real commit is a different change — but the check would not
 * notice. Left as-is deliberately: PR-Agent writes this comment without a
 * marker, so requiring one would re-trigger a review on every trivial PR
 * forever, which is the comment spam this function exists to stop.
 */
export async function findTrivialNoReviewMarker(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
): Promise<boolean> {
	const comments = await listAllComments(api, token, repo, pr)
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

/** Page size and hard stop for the installation walk below. */
const INSTALL_PAGE_SIZE = 100
const MAX_INSTALL_PAGES = 20

/**
 * Best-effort installation id for `repo` — Python lines 418-430.
 *
 * Walks every installation's repository list looking for the repo. It is
 * best-effort in the Python too, and that matters more than it looks: a wrong
 * or missing `installation.id` costs PR-Agent its installation token, so the
 * review is degraded, whereas a RAISED exception would abort the tick. Any
 * failure here means id 0, and the webhook is still sent.
 *
 * BOTH lists are paged. They used to be single reads — `/app/installations`
 * (30 by default) and `/installation/repositories?per_page=100` — so an app
 * installed on more than a page of accounts, or a target repo past the first
 * hundred, resolved to id 0 and every review for it silently lost its
 * installation token. A short page ends each walk, and the caps stop a server
 * that ignores `page` from spinning.
 */
async function resolveInstallId(api: GhAppClient, repo: string): Promise<number> {
	try {
		for (let page = 1; page <= MAX_INSTALL_PAGES; page++) {
			const { data: installs } = await api.request(
				"GET",
				`/app/installations?per_page=${INSTALL_PAGE_SIZE}&page=${page}`,
			)
			if (!Array.isArray(installs)) return 0
			if (!installs.length) break
			for (const inst of installs) {
				const id = (inst as { id?: number })?.id
				if (typeof id !== "number") continue
				const token = await api.installationToken(id)
				for (let rp = 1; rp <= MAX_INSTALL_PAGES; rp++) {
					const { data: repos } = await api.request(
						"GET",
						`/installation/repositories?per_page=${INSTALL_PAGE_SIZE}&page=${rp}`,
						{ token },
					)
					// Python line 425 guards the dict before `.get`, and filters non-dict
					// entries; both are reproduced so a malformed entry cannot throw here.
					const list =
						repos !== null &&
						typeof repos === "object" &&
						Array.isArray((repos as any).repositories)
							? (repos as any).repositories
							: []
					const fulls = (list as any[])
						.filter((r: any) => r !== null && typeof r === "object")
						.map((r: any) => r.full_name)
					if (fulls.includes(repo)) return id
					if (list.length < INSTALL_PAGE_SIZE) break
				}
			}
			if (installs.length < INSTALL_PAGE_SIZE) break
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

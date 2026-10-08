// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code; GitHub payloads are untyped JSON
/**
 * CI gate + stale-CI close — port of `scripts/pr-queue-worker.py` lines
 * 395-406 (`check_ci_passed`) and 564-580 (`close_stale_ci_pr`), plus the
 * `STALE_CI_CLOSE_DAYS` constant from line 586.
 *
 * The gate answers one question: is the head SHA's CI green? The close answers
 * the follow-up — a dependabot bump whose CI has failed for days will never
 * pass (the bump is incompatible with the stack), so the worker closes it
 * instead of printing "Waiting for green CI" on it forever.
 *
 * MESSAGE STRINGS ARE THE CONTRACT. They are interpolated into the report
 * buffer and into the close comment, and the worker's own logic branches on
 * substrings of them (`"typecheck" in ci_msg` at Python line 1958, which drives
 * the bun.lock / uv.lock pre-fix). Rewording, re-punctuating or re-ordering any
 * of them silently changes behaviour, so they are transcribed byte for byte.
 *
 * The `failed[:3]` / `pending[:3]` slice is a cap on a NOTIFICATION, not a
 * filter: a 12-check failure list reports its first three, exactly as Python did.
 */
import type { GhClient } from "./scan.ts"

/** Python `STALE_CI_CLOSE_DAYS` (line 586) — used in the close comment. */
export const STALE_CI_CLOSE_DAYS = 2

/**
 * Python's `(ok, msg)` pair, as an object. `unknown` is the port's addition: it
 * separates "CI is red" from "we could not read CI", which the Python collapsed
 * into one `ok` and which the caller must branch on — `unknown` waits, red
 * closes a stale Dependabot PR.
 */
export type CiResult = { ok: boolean; msg: string; unknown?: boolean }

/**
 * Python's `(status, comment_status)` pair from `close_stale_ci_pr` (line 580).
 * A superset of the `{status}` shape the task brief specifies: the PATCH status
 * is what the caller gates on (Python line 2056-2057), but the comment status
 * is the one diagnostic worth keeping when a close "succeeded" without the
 * explanation actually landing.
 */
export type CloseResult = { status: number; commentStatus: number }

/** The first `n` check names, joined — Python lines 403 and 405. */
const NAME_CAP = 3
const joinNames = (checks: any[]): string =>
	checks
		.slice(0, NAME_CAP)
		.map((c) => c?.name)
		.join(", ")

/**
 * Python `check_ci_passed(token, repo_full, sha)` (lines 395-406).
 *
 * No CI CONFIGURED is a pass, not a failure: a repo with no checks has nothing
 * to wait for, and blocking it would wedge the worker on a PR that can never
 * turn green. That reading is only safe for a request that SUCCEEDED. The
 * Python answered a failed `request` (status 0, `data: {}` per github.ts) the
 * same way as an empty one — it keyed off the data, not the status — and this
 * port copied that, until GitHub's 2026-10-07 incident made the aliasing
 * expensive: every `/check-runs` call came back 500, `check_runs` read empty,
 * the gate said "No CI configured", and two red Dependabot PRs walked all the
 * way to `stepMerge`. A non-200 now returns `unknown` instead, which the caller
 * treats as "we do not know" — never as green, and never as a reason to close
 * the PR either, because the CI verdict is the very thing that is missing.
 *
 * The check list is read defensively: `data.get("check_runs", [])` only works
 * on a dict, and the Python guards that with `isinstance(data, dict)`. The
 * guard is reproduced rather than assumed, because a null body is a real
 * response shape (a 204 or an error envelope), not a hypothetical.
 */
export async function checkCiPassed(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
): Promise<CiResult> {
	const { status, data } = await api.request("GET", `/repos/${repo}/commits/${sha}/check-runs`, {
		token,
	})
	const checks =
		data !== null && typeof data === "object" && Array.isArray((data as any).check_runs)
			? ((data as any).check_runs as any[])
			: []

	if (!checks.length) {
		// Only a 200 proves "this repo has no checks". A non-200 — the transport
		// sentinel, a 5xx, an error envelope — means we could not read the gate,
		// and green would be a guess.
		if (status !== 200)
			return { ok: false, unknown: true, msg: `⚠️ CI status unavailable (HTTP ${status})` }
		return { ok: true, msg: "✅ No CI configured — skipping CI gate" } // line 399
	}

	// Python lines 400-405. `conclusion === "failure"` only — a cancelled or
	// timed-out run is NOT a failure here, it is pending, and the two produce
	// different messages. The failure check comes first so a mixed run reports
	// the terminal problem rather than the in-flight one.
	const failed = checks.filter((c) => c?.conclusion === "failure")
	if (failed.length) return { ok: false, msg: `CI FAILED: ${joinNames(failed)}` }
	const pending = checks.filter((c) => c?.status !== "completed")
	if (pending.length) return { ok: false, msg: `CI pending: ${joinNames(pending)}` }

	return { ok: true, msg: `✅ ${checks.length} checks green` } // line 406
}

/**
 * Python `close_stale_ci_pr(token, repo_full, pr_num, title, ci_msg)`
 * (lines 564-580).
 *
 * ORDER IS LOAD-BEARING: the comment is POSTed BEFORE the PR is closed, and
 * the comment is best-effort — Python line 576 assigns the comment result and
 * both call sites (lines 1893, 2056) discard it with `_`, so the close happens
 * regardless of whether the comment landed. The comment still goes first
 * because it is the only record of WHY the PR was closed, and a close with no
 * comment leaves a dependabot author with a silent rejection.
 *
 * The em-dashes, backticks and the exact wording are transcribed from Python
 * lines 567-575; they land verbatim on a public PR.
 */
export async function closeStaleCiPr(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
	_title: string,
	ciMsg: string,
): Promise<CloseResult> {
	// `title` is a parameter in the Python signature (line 564) that the comment
	// body never reads. It is KEPT so this call site is the Python's call site —
	// the next task wires the PR loop and should be able to paste the Python's
	// argument list unchanged. `noUnusedParameters` is off, so an unused
	// parameter is not an error here.
	const body =
		`⛔ Auto-closed by PR Queue Worker — **stale failing CI**.\n\n` +
		`CI has been failing for ${STALE_CI_CLOSE_DAYS}+ days on this ` +
		`dependency bump: \`${ciMsg}\`. The update is incompatible with the ` +
		`current stack and will not be merged; the worker would otherwise ` +
		`wait on it forever.\n\n` +
		`If this dependency genuinely needs updating, open a proper PR with ` +
		`the required code changes so CI can pass.`

	const comment = await api.request("POST", `/repos/${repo}/issues/${pr}/comments`, {
		token,
		json: { body },
	})
	// Python line 579: the close is NOT conditional on the comment succeeding.
	const closed = await api.request("PATCH", `/repos/${repo}/pulls/${pr}`, {
		token,
		json: { state: "closed" },
	})
	return { status: closed.status, commentStatus: comment.status }
}

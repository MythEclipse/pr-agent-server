/**
 * `openSyncPr` — push the merged workdir as an `upstream-sync-<ts>` branch and
 * open a PR against the base branch.
 *
 * Extracted verbatim from `openSyncPr` in `./run` so that file comes back under
 * the 400-line cap, and because `syncForkRepo` (now ./fork) calls it: leaving it
 * in `run.ts` would have made the pair circular in VALUE terms. THIS IS A MOVE,
 * NOT A REWRITE — the signature, its twelve parameters, the `time.strftime`
 * rendering, the PR body and both `return 0` exits are unchanged, and the
 * Python (1690-1720) is the reference.
 *
 * `run.ts` re-exports this, so the test suite's `from "./run.ts"`
 * import and every other caller are untouched by the move.
 */
import { type GitRunner, pushRef } from "../git.ts"
import type { GhAppClient } from "../pr/scan.ts"
import { SYNC_PR_PREFIX } from "./merge.ts"

/** Python's `subprocess.run(..., timeout=60)` at line 1696. */
const CHECKOUT_TIMEOUT_SEC = 60 // 1696

/** Python's `time.strftime("%Y%m%d-%H%M%S")` (line 1695), in UTC. */
function syncBranchStamp(epochSec: number): string {
	const d = new Date(epochSec * 1000)
	const p = (n: number, w = 2) => String(n).padStart(w, "0")
	return (
		`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
		`-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
	)
}

// ── open_sync_pr ─────────────────────────────────────────────────────────────

/**
 * `openSyncPr`'s injected extras, so the timestamp and the PAT are testable.
 * Deliberately NOT carrying `workdirs`: `openSyncPr` takes the workdir as a
 * path and does no filesystem work of its own, so an injected fs port here was
 * dead weight the caller had to supply for no effect.
 */
export type OpenPrOpts = {
	now: () => number
	fetchGhToken?: () => string
}
/**
 * Python `open_sync_pr(...)` (lines 1690-1720): "Push the merged workdir as a
 * `upstream-sync-<ts>` branch and open a PR against base_branch. The normal
 * worker pipeline (review → CI → approve → merge) finishes the job. Returns the
 * PR number, or 0 on failure."
 *
 * The timestamp is `time.strftime("%Y%m%d-%H%M%S")` (line 1695), which is LOCAL
 * time in the Python; this renders UTC. The value is a unique-enough branch
 * name, and using UTC keeps a cron tick's naming deterministic instead of
 * depending on the host's TZ.
 *
 * The BRANCH is pushed before the PR is created, and a failed push returns 0
 * WITHOUT creating a PR (lines 1699-1700) — a PR with a missing head is a
 * confusing 422 rather than a clean "push failed".
 *
 * The BODY is transcribed verbatim, including the numbers an operator needs to
 * judge the merge: how many upstream commits came in, and how many fork-only
 * commits survived (the divergence this feature exists to preserve).
 */
export async function openSyncPr(
	run: GitRunner,
	api: GhAppClient,
	token: string,
	workdir: string,
	fork: string,
	parent: string,
	baseBranch: string,
	upstreamBranch: string,
	upstreamSha: string,
	mergeCount: number,
	divergence: number,
	resolution: string,
	opts: OpenPrOpts,
): Promise<number> {
	const syncBranch = `${SYNC_PR_PREFIX}${syncBranchStamp(opts.now())}`
	const checkout = run(["checkout", "-b", syncBranch], workdir, CHECKOUT_TIMEOUT_SEC)
	if (checkout.code !== 0) return 0

	const pushed = pushRef(workdir, fork, "HEAD", `refs/heads/${syncBranch}`, token, false, {
		pat: opts.fetchGhToken?.() ?? "",
		run,
	})
	if (!pushed.ok) return 0 // Python line 1700

	const body =
		`⬆️ Automated upstream sync from \`${parent}\` (branch \`${upstreamBranch}\`).\n\n` +
		`- upstream commits merged: **${mergeCount}**\n` +
		`- fork-only commits preserved: **${divergence}**\n` +
		`- upstream tip: \`${upstreamSha}\`\n` +
		`- merge: ${resolution}\n\n` +
		`Opened by pr-queue-worker because \`${baseBranch}\` is a protected branch, so the\n` +
		"merge goes through the normal pipeline (PR-Agent review → AI fix → CI → approve → merge).\n\n" +
		`Compare: https://github.com/${fork}/compare/${baseBranch}...${parent}:${upstreamBranch}`

	const { status, data } = await api.request("POST", `/repos/${fork}/pulls`, {
		token,
		json: {
			title: `⬆️ upstream-sync: merge ${parent}@${upstreamSha.slice(0, 8)} into ${baseBranch}`,
			head: syncBranch,
			base: baseBranch,
			body,
		},
	})
	if (status === 200 || status === 201) {
		const n = Number(data?.number)
		return Number.isFinite(n) ? n : 0 // Python line 1719
	}
	return 0
}

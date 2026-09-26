/**
 * Approve + merge actions — port of `scripts/pr-queue-worker.py` lines
 * 455-458 (`approve_pr`) and 460-470 (`merge_pr`).
 *
 * THE 403 RETRY IS THE WHOLE POINT OF `mergePr`. A GitHub App without the
 * `workflows` permission cannot merge a PR that touches `.github/workflows/*`,
 * and merging such a PR *is* a push of those files — so the App gets a 403 on a
 * PR the repository owner could merge. The fix is to retry the same PUT as the
 * owner (a `gh` CLI PAT), and to REPORT THAT RESULT rather than the first one
 * (Python line 469 returns the retry's tuple, not the original 403). A caller
 * that read the first 403 would report "merge denied" for a merge that worked.
 *
 * Both functions return the HTTP status VERBATIM and never throw: `api.request`
 * already degrades a transport failure to `{status: 0, data: {}}`
 * (github.ts), and the pipeline branches on that status. `0` therefore means
 * "could not ask GitHub", which is distinct from a real 4xx and is reported the
 * same way — as a status the caller judges.
 */
import type { GhClient } from "./scan";

/** Python's `(status, data)` pair from `merge_pr`, as an object. */
export type MergeResult = { status: number; data: any };

/** The one thing `mergePr` needs from the outside world. */
export type MergeDeps = {
  /** Python `_fetch_gh_token()` (lines 599-605). `""` means "no PAT". */
  fetchGhToken: () => string;
};

/**
 * Python `approve_pr(token, repo_full, pr_num)` (lines 455-458).
 *
 * The body is transcribed verbatim, emoji and period included: it lands on a
 * public PR as an approval comment, and GitHub shows it beside the reviewer's
 * name. Returns the status only — the response body is discarded in the Python
 * (`status, _ = gh_api(...)`) and carries nothing the caller uses.
 */
export async function approvePr(
  api: GhClient,
  token: string,
  repo: string,
  pr: number,
): Promise<number> {
  const { status } = await api.request("POST", `/repos/${repo}/pulls/${pr}/reviews`, {
    token,
    json: { event: "APPROVE", body: "✅ Auto-approved by PR Queue Worker." },
  });
  return status; // Python line 458
}

/**
 * Python `merge_pr(token, repo_full, pr_num, sha)` (lines 460-470).
 *
 * `sha` is the head sha, and it is sent as a pre-merge condition: GitHub
 * refuses the merge if the head moved, which is the last line of defence after
 * `checkPrStillValid` re-validates. `merge_method: "merge"` keeps a merge commit,
 * not a squash or rebase, matching the Python payload exactly.
 *
 * ONLY 403 is retried. A 405 (not mergeable) and a 409 (head moved) are
 * definitive answers that the owner PAT would receive identically, so retrying
 * them would double the API calls for no new information.
 */
export async function mergePr(
  deps: MergeDeps,
  api: GhClient,
  token: string,
  repo: string,
  pr: number,
  sha: string,
): Promise<MergeResult> {
  const path = `/repos/${repo}/pulls/${pr}/merge`;
  // Key order is the Python dict's (line 461).
  const json = { commit_title: `Auto-merge PR #${pr}`, merge_method: "merge", sha };

  const first = await api.request("PUT", path, { token, json });
  if (first.status === 403) {
    // Python lines 463-469.
    const pat = deps.fetchGhToken();
    if (pat) {
      // The RETRY's result is what the caller gets — a successful PAT merge must
      // not be reported as the App's 403.
      return api.request("PUT", path, { token: pat, json });
    }
  }
  return { status: first.status, data: first.data };
}

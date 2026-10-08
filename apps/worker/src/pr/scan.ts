/**
 * Open-PR fan-out — port of `scripts/pr-queue-worker.py` lines 301-316
 * (`gather_open_prs`).
 *
 * The App has no webhook delivery of its own here: the worker asks GitHub who
 * the App is installed on, then for each installation which repositories it can
 * see, then for the open PRs of each of those. Each PR is returned with the
 * installation token that can act on it, because every later step (comment,
 * review, close, merge) reuses that token.
 *
 * WHY THE TYPES ARE STRUCTURAL, NOT `GitHubApi`:
 * the Python reaches for a module-level `gh_api`; here the client is a
 * parameter. Narrowing it to the concrete class would force every test to build
 * a real `GitHubApi` (an RSA key, a listener) to exercise a pure fan-out rule.
 * `GitHubApi` satisfies these shapes structurally, so production wiring is
 * unchanged and the tests stay hermetic.
 *
 * DEFENSIVE SHAPE GUARDS, not naive translations: Python's
 * `isinstance(installs, list)` / `repos.get("repositories", [])` are reproduced
 * as real checks, because `request` returns `{}` on a transport failure (github.ts)
 * and `repos.get` on a non-dict would raise inside a cron tick. The one place
 * Python WOULD raise is a non-dict `repos`; the guard is a deliberate, safe
 * improvement, not a behaviour change on any path Python survives.
 */

/** The subset of `GitHubApi.request` this module uses. */
export type GhClient = {
  request(
    method: string,
    path: string,
    opts?: { token?: string; json?: unknown },
  ): Promise<{ status: number; data: any }>;
};

/** `GhClient` plus the token minting `gatherOpenPrs` needs. */
export type GhAppClient = GhClient & {
  installationToken(installId: number): Promise<string>;
};

/** Python's `(token, repo_full, pr)` triple, as an object. */
export type OpenPr = { token: string; repo: string; pr: any };

/** Python `str.title` is irrelevant here; this is just a printable field. */
const repoField = (repo: any): string | undefined =>
  typeof repo?.full_name === "string" ? repo.full_name : undefined;

/**
 * Python `gather_open_prs()` (lines 301-316).
 *
 * `GET /app/installations` → per installation
 * `GET /installation/repositories` → `GET /repos/{full}/pulls?state=open&per_page=20&sort=updated`.
 *
 * Two filters are load-bearing, both copied exactly:
 *   - an installation whose token is empty is SKIPPED (line 308-309): a failed
 *     token mint would otherwise produce calls that all 401 and look like a
 *     repo with no PRs, which is a different (and wrong) conclusion;
 *   - a pulls body that is not an array contributes nothing (line 313-314):
 *     a rate-limit or 404 object is not "zero PRs", but acting on it as such
 *     would silently skip the PRs the worker exists to process.
 *
 * `status` is deliberately NOT branched on, matching the Python: `gh_api`
 * returns the status and the caller ignores it (line 303, 310, 312 discard the
 * first tuple element). Branching here would be a behaviour change, and the
 * shape guards already make the degenerate responses safe.
 */
export async function gatherOpenPrs(api: GhAppClient): Promise<OpenPr[]> {
  const results: OpenPr[] = [];
  const { data: installs } = await api.request("GET", "/app/installations");
  if (!Array.isArray(installs)) return results; // Python lines 304-305
  for (const inst of installs) {
    const id = (inst as { id?: number })?.id;
    if (typeof id !== "number") continue; // guard: `inst["id"]` would throw
    const token = await api.installationToken(id);
    if (!token) continue; // Python lines 308-309
    const { data: repos } = await api.request("GET", "/installation/repositories", { token });
    const list =
      repos !== null && typeof repos === "object" && Array.isArray((repos as any).repositories)
        ? (repos as any).repositories
        : [];
    for (const repo of list) {
      const fullName = repoField(repo);
      if (!fullName) continue; // guard: `repo['full_name']` would throw
      const { data: prs } = await api.request(
        "GET",
        `/repos/${fullName}/pulls?state=open&per_page=20&sort=updated`,
        { token },
      );
      if (Array.isArray(prs)) {
        for (const pr of prs) results.push({ token, repo: fullName, pr });
      }
    }
  }
  return results;
}

/**
 * Fork discovery and upstream comparison — port of
 * `scripts/pr-queue-worker.py` lines 1069-1091 (`list_fork_repos`),
 * 1092-1119 (`upstream_status`) and 1120-1127 (`_sync_open_pr`).
 *
 * WHY `GhClient` AND NOT `GitHubApi`: the Python reaches for a module-level
 * `gh_api`, and the port keeps that injectable instead. `GitHubApi.request`
 * NEVER throws — it exhausts its retries and returns `{status: 0, data: {}}`
 * (github.ts) — so every call site here BRANCHES ON `status` rather than
 * wrapping in try/catch. A test fake with only `request` (and
 * `installationToken`) is enough for every rule here.
 *
 * THE COMPARE PATH IS THE WHOLE FEATURE, so its two quirks are load-bearing:
 *
 * 1. `compare/{local}...{parent}:{upstream}` — the head ref is
 *    `{owner}:{branch}`, NOT `{owner}/{repo}:{branch}`. The full parent name
 *    404s (verified live 2026-09-21), so only `parent.split("/")[0]` goes in.
 * 2. `ahead_by` is "upstream commits the fork LACKS" (what a sync would merge)
 *    and `behind_by` is the fork's own divergence, which is never discarded.
 *    The docstring records the `git rev-list --count` cross-check.
 */
import type { GhAppClient } from "../pr/scan.ts";
import { SYNC_PR_PREFIX } from "./merge.ts";

/**
 * `[app_token, fork_full_name, parent_full_name, default_branch]` for every
 * fork in the installation — the Python's 4-tuple, kept as a tuple because the
 * brief specifies that return shape.
 */
export type ForkRepo = [string, string, string, string];

/** What `upstreamStatus` returns, or null when the comparison is unavailable. */
export type UpstreamInfo = [mergeCount: number, divergence: number, upstreamTip: string];

const asObject = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Python `list_fork_repos()` (lines 1069-1091).
 *
 * "For every repo the GitHub App is installed on whose metadata says
 * `fork: true`" — and the parent lookup is PER REPO, because the `parent`
 * block is authoritative on the repo object and is not in the installation
 * listing (line 1084-1085).
 *
 * Three filters are copied exactly:
 *   - a non-list `installations` body contributes nothing (line 1075);
 *   - a repository without `full_name`, or with `fork` falsy, is skipped
 *     (lines 1082-1083) — `fork: false` is the common case, so this is the
 *     filter that keeps the installation listing from becoming the work list;
 *   - a `parent` without `full_name`, or a non-200 metadata call, is skipped
 *     (lines 1086-1087). The App gets 403 (not 404) on some repos, and a repo
 *     whose parent cannot be resolved has nothing to sync FROM.
 *
 * `default_branch` falls back to `"main"` (line 1088) — the same fallback the
 * branch resolution in `runUpstreamSync` applies.
 */
export async function listForkRepos(api: GhAppClient): Promise<ForkRepo[]> {
  const out: ForkRepo[] = [];
  const { data: installs } = await api.request("GET", "/app/installations");
  if (!Array.isArray(installs)) return out; // Python line 1075

  for (const inst of installs) {
    const id = (inst as { id?: number })?.id;
    if (typeof id !== "number") continue; // guard: `inst["id"]` would throw
    const token = await api.installationToken(id);
    if (!token) continue; // Python line 1077
    const { data: repos } = await api.request(
      "GET",
      "/installation/repositories?per_page=100",
      { token },
    );
    const list = Array.isArray(asObject(repos)?.repositories)
      ? (repos as any).repositories
      : [];
    for (const r of list) {
      const full = str(r?.full_name);
      if (!full || !r?.fork) continue; // Python lines 1082-1083
      const { status, data: meta } = await api.request("GET", `/repos/${full}`, { token });
      const parent = asObject(meta)?.parent;
      const parentFull = str(asObject(parent)?.full_name);
      if (status !== 200 || !parentFull) continue; // Python lines 1086-1087
      const defaultBranch = str(asObject(meta)?.default_branch) || "main"; // line 1088
      out.push([token, full, parentFull, defaultBranch]);
    }
  }
  return out;
}

/** What `upstreamStatus` needs beyond the request itself. */
export type UpstreamStatusOpts = {
  /** Python `_fetch_gh_token()` (line 1106) — `""` means no PAT is available. */
  fetchGhToken?: () => string;
};

/**
 * Python `upstream_status(token, fork, parent, local_branch, upstream_branch)`
 * (lines 1092-1117): "(merge_count, fork_divergence, upstream_tip_sha) for the
 * fork branch vs the upstream branch, or None when the comparison is
 * unavailable."
 *
 * THE PAT RETRY IS EXACTLY THE PYTHON'S: on a non-200, retry ONCE with the
 * owner PAT (lines 1105-1108), because an installation token cannot read a
 * PRIVATE upstream while the owner PAT can. It is not a generic retry — the
 * second response replaces the first, and a second failure is `null`.
 *
 * THE TIP FALLBACK (lines 1112-1116): `commits[-1].sha` is the tip only for
 * an up-to-date compare, and an EMPTY `commits` list happens when
 * `ahead_by`/`behind_by` say there is nothing to merge. Then, and only then,
 * the parent's commit endpoint supplies the sha — because `run_upstream_sync`
 * stores it as `last_attempt_sha`, and without a tip it could not tell "already
 * handled" from "new upstream commit". The second call uses the ORIGINAL
 * token, not the PAT.
 */
export async function upstreamStatus(
  api: GhAppClient,
  token: string,
  fork: string,
  parent: string,
  localBranch: string,
  upstreamBranch: string,
  opts: UpstreamStatusOpts = {},
): Promise<UpstreamInfo | null> {
  // Python line 1102: the OWNER part only.
  const owner = parent.includes("/") ? parent.split("/")[0] : parent;
  const path = `/repos/${fork}/compare/${localBranch}...${owner}:${upstreamBranch}`;
  let { status, data } = await api.request("GET", path, { token });
  if (status !== 200) {
    const pat = opts.fetchGhToken?.() ?? "";
    if (pat) ({ status, data } = await api.request("GET", path, { token: pat }));
  }
  const body = asObject(data);
  if (status !== 200 || !body) return null; // Python line 1110

  const commits = Array.isArray(body.commits) ? body.commits : [];
  let tip = commits.length ? str(commits[commits.length - 1]?.sha) : "";
  if (!tip) {
    const second = await api.request("GET", `/repos/${parent}/commits/${upstreamBranch}`, { token });
    if (second.status === 200) tip = str(asObject(second.data)?.sha);
  }
  // `int(...)` on a missing or non-numeric count is ZERO in the sense that
  // matters here: a non-numeric value must not become NaN, because NaN fails
  // every `merge_count <= 0` comparison as `false` and the fork would be synced
  // against garbage.
  return [toInt(body.ahead_by), toInt(body.behind_by), tip];
}

/** Python `int(data.get("ahead_by", 0))` — non-finite/absent becomes 0. */
function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Python `_sync_open_pr(token, fork, base_branch)` (lines 1120-1127):
 * "Number of an already-open upstream-sync PR targeting base_branch, else 0."
 *
 * The gating use is what makes this load-bearing: a fork whose sync PR is
 * already open must not open a SECOND one, or every protected fork accumulates
 * a queue of duplicate sync PRs. Both conditions are ANDed — the head prefix
 * AND the base branch — so an `upstream-sync-` PR against another branch does
 * not block this one.
 */
export async function syncOpenPr(
  api: GhAppClient,
  token: string,
  fork: string,
  baseBranch: string,
): Promise<number> {
  const { data: prs } = await api.request(
    "GET",
    `/repos/${fork}/pulls?state=open&per_page=50`,
    { token },
  );
  if (!Array.isArray(prs)) return 0; // Python line 1124
  for (const pr of prs) {
    const headRef = str(asObject(pr?.head)?.ref);
    if (headRef.startsWith(SYNC_PR_PREFIX) && str(asObject(pr?.base)?.ref) === baseBranch) {
      const n = Number((pr as any)?.number);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

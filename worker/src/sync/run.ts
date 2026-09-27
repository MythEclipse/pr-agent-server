/**
 * The sync orchestrator — port of `scripts/pr-queue-worker.py` lines 1518-1689
 * (`sync_fork_repo`), 1690-1720 (`open_sync_pr`) and 1723-1829
 * (`run_upstream_sync`).
 *
 * THE ORDERING IN `syncForkRepo` IS THE FEATURE, so it is spelled out once here
 * and nowhere repeated: clone → identity → `pre_merge_sha` → fetch upstream
 * `--no-tags <url> <branch>:refs/remotes/upstream/<branch>` → merge → detect
 * unmerged → (agent → SALVAGE → finish-merge) OR (quality pass on a clean
 * merge) → `syncFinishMerge` guards → `pushRef` → protected? → `openSyncPr` →
 * state update → workdir removed in a `finally`.
 *
 * FOUR THINGS THAT LOOK LIKE OPTIMISATIONS AND ARE NOT:
 *
 * 1. THE MERGE IS A MERGE, NEVER A REBASE. The fork keeps its local
 *    divergence (Python lines 963-984). `git merge <remote-ref> --no-edit`
 *    with the upstream ref under `refs/remotes/upstream/` is what makes the
 *    merge commit a real two-parent commit the revert path can reason about.
 * 2. THE SALVAGE ORDER IS agent → unmerged check → salvage (lines 1575-1596).
 *    An `ok:false` from the agent does NOT mean failure: resolving N conflicts
 *    legitimately runs past the HTTP timeout (observed: 17 files ≈ 16 min,
 *    128 API calls), so the call can time out AFTER the agent committed. The
 *    salvage is therefore `syncFinishMerge(workdir)` — which re-reads the
 *    ACTUAL unmerged state — and only a refusal there aborts. Checking the
 *    unmerged list BEFORE the agent (i.e. caching the pre-agent list) turns
 *    every recoverable merge into a `conflict-failed`, which is the exact
 *    failure this task exists to prevent.
 * 3. DRY RUNS ARE PURE. `runUpstreamSync` builds a throwaway state and passes
 *    it in; `syncForkRepo` additionally never mutates the state it was given,
 *    never pushes, never opens a PR and never posts to Discord (lines
 *    1527-1531, 1565, 1589, 1602, 1627, 1657, 1788). The workdir is KEPT in dry
 *    mode, because "prepared in <dir>" is the entire point of a dry run.
 * 4. THE BUDGET IS PER TICK AND THE ORDER IS STALEST-FIRST (lines 1746-1747).
 *    Sorting on `last_sync_ts or 0` before spending `max_per_tick` is what
 *    makes the budget rotate fairly across forks instead of always serving
 *    whichever one the installation listing happened to return first.
 */
import { pushRef, type GitRunner } from "../git";
import { head, reportable, type Workdirs } from "../pr/lockfix";
import type { GhAppClient } from "../pr/scan";
import type { PostResult } from "../agent";
import { loadSyncState, saveSyncState, SYNC_STATE_FILE } from "../state";
import { num, pendingVerify, syncConfig, syncEntry, upstreamSyncEnabled } from "./config";
import type { RepoOverrides, SyncConfig, SyncState } from "./config";
import { listForkRepos, syncOpenPr, upstreamStatus } from "./repos";
import {
  QUALITY_LINE,
  RESOLVING_LINE,
  SALVAGE_LINE,
  SYNC_PR_PREFIX,
  SYNC_TMP_BASE,
  conflictPrompt,
  qualityPrompt,
  setSyncIdentity,
  syncCommitIfDirty,
  syncFetchUrl,
  syncFinishMerge,
  syncRevertMerge,
  syncUnmergedFiles,
  type RevertArgs,
  type RevertOutcome,
} from "./merge";
import { verifyPendingSyncs } from "./verify";
import { resolveMerge } from "./resolve";
import { sweepForks } from "./sweep";

// ── Types ────────────────────────────────────────────────────────────────────
//
// Moved to ./types so this file fits the 400-line cap, and re-exported here
// rather than fixed: eleven modules and the test suite already import these
// names from "./run", so keeping the re-export means the move changed no
// caller. See ./types for the note on why `report` is required.
import type {
  PostDiscord,
  ReportPort,
  RunUpstreamSyncDeps,
  SyncAgentPort,
  SyncForkDeps,
  SyncRequest,
  SyncResult,
  SyncStatus,
} from "./types";
export type {
  PostDiscord,
  ReportPort,
  RunUpstreamSyncDeps,
  SyncAgentPort,
  SyncForkDeps,
  SyncRequest,
  SyncResult,
  SyncStatus,
} from "./types";

// ── Timeout budgets, one per Python `subprocess.run(..., timeout=N)` ──────────
const CLONE_TIMEOUT_SEC = 300; // 1536
const REV_PARSE_TIMEOUT_SEC = 30; // 1543, 1633
const FETCH_TIMEOUT_SEC = 300; // 1546
const MERGE_TIMEOUT_SEC = 300; // 1553
const ABORT_TIMEOUT_SEC = 60; // 1562, 1587, 1598
const MERGE_DIFF_TIMEOUT_SEC = 120; // 1609
const CHECKOUT_TIMEOUT_SEC = 60; // 1696

/** Python `clone failed: {stderr[:200]}` (1540) and the same width at 1551. */
const CLONE_DETAIL = 200;
/** Python `merge error: {(stderr+stdout)[:200]}` (1558). */
const MERGE_ERROR_DETAIL = 200;
/** Python `detail[:200]` on the push-failed paths (1675, 1679). */
const PUSH_DETAIL = 200;
/** Python `snippet[:200]` in the conflict-failure note (1588). */
const SNIPPET = 200;
/** Python `snippet[:120]` in the quality-skip note (1622). */
const SHORT_SNIPPET = 120;
/** Python `snippet[:80]` in the salvage note (1585). */
const SALVAGE_SNIPPET = 80;
/** Python `detail[:300]` on the final push-failed return (1682). */
const PUSH_REPORT = 300;
/** Python's `0x5865F2` default embed colour (line 1036), used explicitly. */
const DISCORD_COLOR = 0x5865f2;
/** Python line 1820's amber for a skipped fork. */
const SKIP_COLOR = 0xe67e22;

const credentialUrl = (token: string, repo: string): string =>
  `https://x-access-token:${token}@github.com/${repo}.git`;

/** Python's `time.strftime("%Y%m%d-%H%M%S")` (line 1695), in UTC. */
function syncBranchStamp(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

// ── sync_fork_repo ───────────────────────────────────────────────────────────

/**
 * Python `sync_fork_repo(...)` (lines 1518-1687): "One sync attempt for one
 * fork: clone → merge upstream → Claude Code when needed → push (or open a PR
 * when the branch is protected)."
 *
 * NEVER THROWS: the Python's `except Exception` becomes the `try`/`finally`
 * here, and the `finally` removes the workdir on every non-dry path (line
 * 1686-1687) — a leaked clone holds a credentialed `.git/config` and a live
 * `.git/index.lock`.
 *
 * EVERY COMMAND'S OUTPUT PASSES THROUGH `reportable` BEFORE IT REACHES A
 * DETAIL, because a detail is reported to the ops Discord channel (Python
 * lines 1787-1821). The Python inherited a credential leak here (worker fix
 * cc15d06): a push or clone error echoes the URL userinfo.
 */
export async function syncForkRepo(
  deps: SyncForkDeps,
  req: SyncRequest,
  state: SyncState,
  cfg: SyncConfig,
  dry = false,
): Promise<SyncResult> {
  const { run, workdirs, agent } = deps;
  const { fork, token, parent, localBranch, upstreamBranch, upstreamSha } = req;
  const workdir = `${SYNC_TMP_BASE}/${fork.replace(/\//g, "_")}`;

  // Python line 1527: a dry run gets a detached entry and never the real one.
  const entry = dry ? {} : syncEntry(state, fork);

  // DIVERGENCE FROM THE PYTHON, deliberate, and required by the brief.
  //
  // Python lines 1539, 1550 and 1557 call `save_sync_state(state)`
  // UNCONDITIONALLY on the clone / fetch / merge-error exits — no `if dry`.
  // In dry mode `entry` is a throwaway dict, so the entry writes go nowhere,
  // but the SAVE still runs with the caller's `state`, which
  // `run_upstream_sync` sets to `{}` (line 1737). The Python therefore writes
  // `{}` over the real `/tmp/pr-queue-sync-state.json` on a dry run — which
  // silently discards every armed `pending_verify` watch and every
  // `skip_reason`, so the next real tick re-does work and the CI revert
  // guarantee is lost with no trace.
  //
  // Brief group 4 states the requirement directly: "Dry run murni: `state == {}`
  // setelah `syncForkRepo(dry)` (tidak ada tulisan)" — no writes. This guard is
  // that requirement, and it is the only behavioural difference in this file
  // that a caller could observe on a NON-dry path (there is none: every
  // non-dry path still saves, at the same points).
  const persist = () => {
    if (!dry) deps.saveState(state);
  };

  try {
    if (workdirs.exists(workdir)) workdirs.remove(workdir); // Python lines 1532-1533
    workdirs.mkdir(SYNC_TMP_BASE); // Python line 1534 (`workdir.parent`)

    const clone = run(
      ["clone", credentialUrl(token, fork), workdir, "--branch", localBranch],
      undefined,
      CLONE_TIMEOUT_SEC,
    );
    if (clone.code !== 0) {
      entry.last_sync_ts = deps.now(); // Python line 1538
      persist();
      return ["error", `clone failed: ${head(reportable(clone.stderr || "").trim(), CLONE_DETAIL)}`];
    }
    setSyncIdentity(run, workdir); // Python lines 1541-1542
    const preMergeSha = (
      run(["rev-parse", "HEAD"], workdir, REV_PARSE_TIMEOUT_SEC).stdout || ""
    ).trim(); // Python line 1543

    const upstreamRef = `refs/remotes/upstream/${upstreamBranch}`; // Python line 1545
    const fetch = run(
      [
        "fetch",
        "--no-tags",
        syncFetchUrl(parent, deps.fetchGhToken()),
        `${upstreamBranch}:${upstreamRef}`,
      ],
      workdir,
      FETCH_TIMEOUT_SEC,
    );
    if (fetch.code !== 0) {
      entry.last_sync_ts = deps.now(); // Python line 1549
      persist();
      return [
        "error",
        `upstream fetch failed: ${head(reportable(fetch.stderr || "").trim(), CLONE_DETAIL)}`,
      ];
    }

    const merge = run(["merge", upstreamRef, "--no-edit"], workdir, MERGE_TIMEOUT_SEC);
    const conflicted = syncUnmergedFiles(run, workdir); // Python line 1554
    if (merge.code !== 0 && conflicted.length === 0) {
      entry.last_sync_ts = deps.now(); // Python line 1556
      persist();
      const combined = `${merge.stderr || ""}${merge.stdout || ""}`;
      return ["error", `merge error: ${head(reportable(combined).trim(), MERGE_ERROR_DETAIL)}`];
    }

    const outcome = await resolveMerge(run, workdir, conflicted, {
      report: deps.report,
      agent,
      cfg,
      skip: (note: string) => skipNote(deps, entry, state, dry, upstreamSha, note),

      dry,
    }, { fork, parent, upstreamBranch, localBranch, preMergeSha });
    if (outcome.kind === "conflict-failed") return ["conflict-failed", outcome.detail];
    const resolution = outcome.resolution;

    // Python lines 1624-1631. A second unmerged read AFTER the agent, because
    // the agent may have left a path unresolved while the first read (before
    // it ran) was clean. Never push an unresolved merge.
    const stillUnmerged = syncUnmergedFiles(run, workdir);
    if (stillUnmerged.length) {
      return [
        "conflict-failed",
        skipNote(
          deps,
          entry,
          state,
          dry,
          upstreamSha,
          `unmerged paths remain: ${stillUnmerged.slice(0, 5).join(", ")}`,
        ),
      ];
    }

    const mergedSha = (
      run(["rev-parse", "HEAD"], workdir, REV_PARSE_TIMEOUT_SEC).stdout || ""
    ).trim(); // Python line 1633

    if (dry) {
      // Python lines 1634-1636. The workdir is deliberately LEFT IN PLACE: the
      // dry run's whole output is "prepared in <dir>", and a caller that wants
      // to inspect the merge needs the clone to still be there.
      //
      // DIVERGENCE FROM THE PYTHON, and it is a repair. In the Python this
      // `return` sits ABOVE the push (line 1634 vs 1638), so the `if protected:
      // if dry: return "pr-path"` at 1657-1659 is DEAD — a dry run can never
      // reach it, and the `pr-path` arm in the reporter is dead code. The
      // rehearsal therefore cannot tell an operator the one fact it exists to
      // surface: that this branch is protected and a PR would be opened.
      //
      // A REAL PUSH IS NOT THE ANSWER and never will be. Classification is
      // learned from the push's failure only because GitHub's App surface
      // answers 403 on the branch-protection endpoint for many installs — but a
      // dry run must have NO remote effect, so the push is off the table
      // entirely. (`git push --dry-run` is not a way out either: it does not
      // run the remote's pre-receive hook, so it exits 0 on a protected branch
      // and cannot classify. Verified against a local bare repo with a
      // GH006-emitting pre-receive hook — the real push failed, the dry-run
      // push returned 0, and the remote ref was unchanged.)
      //
      // So the classification is a READ-ONLY `GET` on the protection endpoint.
      // 200 → protected → `pr-path`. Anything else (404 no rules, 403 no admin
      // scope) is UNKNOWN, and unknown is reported as the plain `dry`: a false
      // pr-path would send an operator hunting for a PR that would never open.
      const protection = await deps.api.request(
        "GET",
        `/repos/${fork}/branches/${localBranch}/protection`,
        { token },
      );
      if (protection.status === 200) {
        return [
          "pr-path",
          `protected branch detected (${localBranch}) — would open an upstream-sync PR`,
        ];
      }
      return [
        "dry",
        `prepared in ${workdir} — pre_merge ${preMergeSha.slice(0, 8)}, ` +
          `upstream ${upstreamSha.slice(0, 8)}, head ${mergedSha.slice(0, 8)}, ${resolution}`,
      ];
    }

    const pushed = pushRef(workdir, fork, "HEAD", `refs/heads/${localBranch}`, token, false, {
      run,
      pat: deps.fetchGhToken(),
    });

    if (pushed.ok) {
      // Python lines 1641-1654. `pending_verify` is what arms the CI watch, and
      // `pre_merge_sha` is the revert target — both must be recorded BEFORE the
      // save, or a crash between push and save leaves a merge nobody watches.
      entry.last_sync_ts = deps.now();
      entry.last_attempt_sha = upstreamSha;
      entry.last_merged_upstream_sha = upstreamSha;
      entry.skip_reason = "";
      entry.notified = false;
      entry.pending_verify = {
        sha: mergedSha,
        pre_merge_sha: preMergeSha,
        branch: localBranch,
        pushed_at: deps.now(),
      };
      deps.saveState(state);
      return [
        "synced",
        `${req.mergeCount} upstream commit(s) merged into ${localBranch} ` +
          `(${resolution}); head ${mergedSha.slice(0, 8)}; ${pushed.detail}`,
      ];
    }

    if (pushed.protected) {
      // Python lines 1656-1667: the App gets 403 (not 404) on the
      // branch-protection endpoint, so "protected" is learned FROM THE PUSH —
      // which is why this branch exists at all.
      const prNum = await openSyncPr(
        run,
        deps.api,
        token,
        workdir,
        fork,
        parent,
        localBranch,
        upstreamBranch,
        upstreamSha,
        req.mergeCount,
        req.divergence,
        resolution,
        { now: deps.now, fetchGhToken: deps.fetchGhToken },
      );
      if (prNum) {
        // A PR-path sync merged NOTHING into the branch, so no CI watch is
        // armed and the merged sha is cleared — otherwise `verifyPendingSyncs`
        // would be watching a commit that does not exist.
        entry.last_sync_ts = deps.now();
        entry.last_attempt_sha = upstreamSha;
        entry.last_merged_upstream_sha = "";
        entry.skip_reason = "";
        entry.notified = false;
        deps.saveState(state);
        return [
          "pr-opened",
          `${localBranch} is protected — opened PR #${prNum} ` +
            `(${req.mergeCount} upstream commit(s), ${resolution})`,
        ];
      }
      entry.last_sync_ts = deps.now();
      persist();
      return [
        "push-failed",
        `protected branch and PR creation failed: ${head(pushed.detail, PUSH_DETAIL)}`,
      ];
    }

    entry.last_sync_ts = deps.now(); // Python lines 1677-1681
    entry.last_attempt_sha = upstreamSha;
    entry.skip_reason = head(pushed.detail, PUSH_DETAIL);
    entry.notified = false;
    deps.saveState(state);
    return ["push-failed", head(pushed.detail, PUSH_REPORT)];
  } catch (err) {
    // Python lines 1683-1684: "a sync must never take the whole tick down".
    return ["error", `${err instanceof Error ? err.name : typeof err}: ${err instanceof Error ? err.message : String(err)}`];
  } finally {
    if (!dry) workdirs.remove(workdir); // Python lines 1686-1687
  }
}

/**
 * Record a skip and return its note. The Python repeats this five-line block at
 * five call sites (lines 1565-1568, 1589-1592, 1600-1603, 1627-1630), and each
 * repetition is the whole "skip ONCE per upstream tip" contract: `last_sync_ts`
 * moves, `last_attempt_sha` names the tip so `run_upstream_sync` will not retry
 * it, and `notified: false` lets the caller post a single Discord alert.
 */
function skipNote(
  deps: SyncForkDeps,
  entry: Record<string, unknown>,
  state: SyncState,
  dry: boolean,
  upstreamSha: string,
  note: string,
): string {
  if (dry) return note;
  entry.last_sync_ts = deps.now();
  entry.last_attempt_sha = upstreamSha;
  entry.skip_reason = note;
  entry.notified = false;
  deps.saveState(state);
  return note;
}

// ── open_sync_pr ─────────────────────────────────────────────────────────────

/**
 * `openSyncPr`'s injected extras, so the timestamp and the PAT are testable.
 * Deliberately NOT carrying `workdirs`: `openSyncPr` takes the workdir as a
 * path and does no filesystem work of its own, so an injected fs port here was
 * dead weight the caller had to supply for no effect.
 */
export type OpenPrOpts = {
  now: () => number;
  fetchGhToken?: () => string;
};

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
  const syncBranch = `${SYNC_PR_PREFIX}${syncBranchStamp(opts.now())}`;
  const checkout = run(["checkout", "-b", syncBranch], workdir, CHECKOUT_TIMEOUT_SEC);
  if (checkout.code !== 0) return 0;

  const pushed = pushRef(
    workdir,
    fork,
    "HEAD",
    `refs/heads/${syncBranch}`,
    token,
    false,
    { pat: opts.fetchGhToken?.() ?? "", run },
  );
  if (!pushed.ok) return 0; // Python line 1700

  const body =
    `⬆️ Automated upstream sync from \`${parent}\` (branch \`${upstreamBranch}\`).\n\n` +
    `- upstream commits merged: **${mergeCount}**\n` +
    `- fork-only commits preserved: **${divergence}**\n` +
    `- upstream tip: \`${upstreamSha}\`\n` +
    `- merge: ${resolution}\n\n` +
    `Opened by pr-queue-worker because \`${baseBranch}\` is a protected branch, so the\n` +
    "merge goes through the normal pipeline (PR-Agent review → AI fix → CI → approve → merge).\n\n" +
    `Compare: https://github.com/${fork}/compare/${baseBranch}...${parent}:${upstreamBranch}`;

  const { status, data } = await api.request("POST", `/repos/${fork}/pulls`, {
    token,
    json: {
      title: `⬆️ upstream-sync: merge ${parent}@${upstreamSha.slice(0, 8)} into ${baseBranch}`,
      head: syncBranch,
      base: baseBranch,
      body,
    },
  });
  if (status === 200 || status === 201) {
    const n = Number(data?.number);
    return Number.isFinite(n) ? n : 0; // Python line 1719
  }
  return 0;
}

// ── run_upstream_sync ────────────────────────────────────────────────────────

/** Python `run_upstream_sync(only=None, dry=False)`'s keyword arguments. */
export type RunUpstreamSyncOptions = { only?: string; dry?: boolean };

/**
 * Python `run_upstream_sync(only=None, dry=False)` (lines 1723-1829): "Sync
 * every fork in the installation (bounded per tick), verify merges we pushed
 * earlier, and return the report lines. Never raises."
 *
 * ORDER MATTERS AND IS THE PYTHON'S: state → fork list → `verify_pending_syncs`
 * FIRST (so a red merge is reverted before new work is layered on top) → then
 * the per-fork loop, stalest-first, bounded by `max_per_tick`.
 *
 * GATES, in the Python's order (lines 1766-1778), each of which must be SILENT
 * (no report line) so a quiet worker stays quiet:
 *   1. `merge_count <= 0` → in sync. Also CLEARS a stale `skip_reason` (the
 *      upstream recovered, so the old note is no longer true).
 *   2. `last_attempt_sha == upstream_sha` → this tip was already handled.
 *   3. `now - last_sync_ts < interval_h * 3600` → not due yet.
 *   4. an upstream-sync PR is already open for the branch → wait.
 * `only` BYPASSES the budget (line 1752-1753), so a manual
 * `--sync-only <repo> --dry` always runs even when the budget is spent.
 */
export async function runUpstreamSync(
  deps: RunUpstreamSyncDeps,
  opts: RunUpstreamSyncOptions = {},
): Promise<string[]> {
  const lines: string[] = [];
  const only = opts.only;
  // `dry` lives in `opts` only. The Python's `run_upstream_sync(only=None,
  // dry=False)` has exactly one place to say it, and a `deps.dry` alongside it
  // would be a second source of truth that can disagree with the first.
  const dry = opts.dry ?? false;
  const enabled = upstreamSyncEnabled();

  // Python lines 1732-1733: disabled means disabled, EXCEPT for an explicit
  // `only`, which is a human asking for one specific fork right now.
  if (!enabled && !only) return lines;

  try {
    // Python lines 1735-1737: a dry run gets a throwaway state so the gating
    // `_sync_entry` calls cannot touch the real /tmp file.
    const state: SyncState = dry ? {} : deps.loadState();

    let forks = await listForkRepos(deps.api);
    if (only) forks = forks.filter((f) => f[1] === only);
    const tokenByRepo: Record<string, string> = {};
    for (const [token, fork] of forks) tokenByRepo[fork] = token;

    // Python line 1742: verification first.
    lines.push(
      ...(await verifyPendingSyncs(
        {
          api: deps.api,
          enabled,
          repoOverrides: deps.repoOverrides,
          now: deps.now,
          saveState: deps.saveState,
          revertMerge: (args: RevertArgs): Promise<RevertOutcome> =>
            Promise.resolve(
              syncRevertMerge(deps.run, deps.workdirs, {
                ...args,
                fetchGhToken: deps.fetchGhToken,
              }),
            ),
          postDiscord: deps.postDiscord,
        },
        state,
        tokenByRepo,
        dry,
      )),
    );

    const now = deps.now();
    // Python line 1746: "oldest attempt first so the per-tick budget rotates
    // fairly across forks". A fork never synced sorts as 0 — oldest.
    const ordered = [...forks].sort(
      (a, b) => num(syncEntry(state, a[1]).last_sync_ts) - num(syncEntry(state, b[1]).last_sync_ts),
    );

    const baseCfg = syncConfig("", deps.repoOverrides, enabled);
    // Python line 1747 reads `UPSTREAM_SYNC["max_per_tick"]` — worker-wide, NOT
    // the per-repo config, so a per-repo override cannot raise the budget.
    let budget = baseCfg.max_per_tick;
    const syncOne = deps.syncForkRepo ?? syncForkRepo;

    await sweepForks(
      deps,
      deps.syncForkRepo ?? syncForkRepo,
      ordered,
      state,
      lines,
      { only, dry, enabled, now, budget: baseCfg.max_per_tick },
    );

    if (!dry) deps.saveState(state); // Python line 1826
  } catch (err) {
    // Python lines 1827-1828: a sync error is a REPORT LINE, never an exception.
    const name = err instanceof Error ? err.name : typeof err;
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`⚠️  Upstream sync error: ${name}: ${msg}`);
  }
  return lines;
}


export type FileSyncState = {
  load: () => SyncState;
  save: (state: SyncState) => void;
};

/** Read/write the sync state against a real file, not the module singleton. */
export function fileSyncState(file: string = SYNC_STATE_FILE): FileSyncState {
  return {
    load: () => loadSyncState(file),
    save: (state) => saveSyncState(file, state),
  };
}

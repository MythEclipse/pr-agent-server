/**
 * The upstream-sync tick: state → fork list → verify merges we pushed earlier →
 * sweep the forks, stalest-first, inside the per-tick budget.
 *
 * Port of `scripts/pr-queue-worker.py` 1723-1829 (`run_upstream_sync`), plus
 * the flow's two state-file entry points. `syncForkRepo` (Python 1518-1687) and
 * `openSyncPr` (Python 1690-1720) moved to ./fork and ./openpr so this file
 * fits the 400-line cap; both are RE-EXPORTED below, so every `from "./run.ts"`
 * import site is unchanged by the split. Their doc comments carry the
 * ordering, the salvage order and the dry-run-purity notes, because that is
 * code they describe now lives.
 *
 * 4. THE BUDGET IS PER TICK AND THE ORDER IS STALEST-FIRST (lines 1746-1747).
 *    Sorting on `last_sync_ts or 0` before spending `max_per_tick` is what
 *    makes the budget rotate fairly across forks instead of always serving
 *    whichever one the installation listing happened to return first.
 */
import { loadSyncState, saveSyncState, SYNC_STATE_FILE } from "../state.ts";
import { num, syncConfig, syncEntry, upstreamSyncEnabled } from "./config.ts";
import type { SyncState } from "./config.ts";
import { listForkRepos } from "./repos.ts";
import { syncRevertMerge, type RevertArgs, type RevertOutcome } from "./merge.ts";
import type { RunUpstreamSyncDeps as RunUpstreamSyncDepsType } from "./types.ts";
import { verifyPendingSyncs } from "./verify.ts";
import { sweepForks } from "./sweep.ts";
import { syncForkRepo } from "./fork.ts";

// Re-exported, not fixed: the test suite and src/index.ts import these two by
// name from "./run.ts", so re-exporting is what keeps the split invisible to them.
export { syncForkRepo } from "./fork.ts";
export { openSyncPr, type OpenPrOpts } from "./openpr.ts";

// ── Types ────────────────────────────────────────────────────────────────────
//
// Moved to ./types so this file fits the 400-line cap, and re-exported here
// rather than fixed: eleven modules and the test suite already import these
// names from "./run.ts", so keeping the re-export means the move changed no
// caller. See ./types for the note on why `report` is required.
export type {
  PostDiscord,
  ReportPort,
  RunUpstreamSyncDeps,
  SyncAgentPort,
  SyncForkDeps,
  SyncRequest,
  SyncResult,
  SyncStatus,
} from "./types.ts";

// No timeout budgets or truncation widths are declared here. Every one of them
// belongs to a fork operation, so they went to ./fork, ./openpr or ./resolve with
// the code that reads them; the colour constants went to ./sweep. Before these
// were deleted, each was checked byte-equal against the copy that survives
// elsewhere, so no width or budget changed value. The alternative — leaving
// duplicates behind in this file — is what made this section misleading: seven
// constants whose only reference was their own declaration.
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
  deps: RunUpstreamSyncDepsType,
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

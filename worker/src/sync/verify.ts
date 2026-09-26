/**
 * CI verification and auto-revert — port of `scripts/pr-queue-worker.py`
 * lines 1451-1517 (`verify_pending_syncs`), the caller of `_sync_revert_merge`
 * (1427-1450).
 *
 * THE FEATURE: the worker pushes merge commits DIRECTLY to fork default
 * branches, so a red main is a red main. This watch reverts our own merge when
 * the fork's CI fails AT THAT COMMIT — but only while that commit is still the
 * tip. Once a human (or another sync) pushes on top, the merge is no longer
 * ours to undo and the watch simply stops.
 *
 * THERE ARE SEVEN EXITS AND THEY ARE NOT INTERCHANGEABLE. Three of them write
 * state, two deliberately do NOT, and the difference is behavioural, not
 * cosmetic. In order (Python lines 1466-1514):
 *
 *   (a) `verify_ci` false, or a dry run → clear, NO save, NO line (1466-1468).
 *       A dry run must leave nothing behind, so it cannot even persist the
 *       clearing.
 *   (b) age > `verify_ci_max_age_h` → clear, SAVE, one line, KEEP the merge
 *       (1470-1475). The merge stays: after 6 hours a revert would race real
 *       development, and the report says so explicitly.
 *   (c) the branch tip moved past our sha → clear, SAVE, one line (1477-1483).
 *       No revert — the guard that keeps the worker from discarding a human's
 *       work.
 *   (d) any check FAILED → revert, clear, `last_merged_upstream_sha = ""`,
 *       SAVE, Discord (1488-1502). Clearing the merged sha is what lets the
 *       next tick try the same upstream tip again.
 *   (e) NO checks and age < `no_ci_grace_s` → CONTINUE, clear nothing, save
 *       nothing (1503-1505). Check-runs may not have registered yet; this is
 *       the one exit that does nothing at all. Note the boundary is
 *       EXCLUSIVE — `age < grace` keeps waiting, `age >= grace` stops.
 *   (f) no checks and past the grace → clear, SAVE, NO line (1506-1508).
 *   (g) still running → CONTINUE, clear nothing, save nothing (1509-1510).
 *   (h) green → clear, SAVE, one line (1511-1514).
 *
 * (a) versus (e) is the asymmetry a naive rewrite loses: one saves and one
 * does not, and both are correct. (a) is a policy change (the watch is off),
 * (e) is patience (the watch is on, we are early).
 */
import type { GhClient } from "../pr/scan";
import { num, pendingVerify, syncConfig } from "./config";
import type { RepoOverrides, SyncState, SyncEntry } from "./config";
import { syncRevertMerge, type RevertArgs, type RevertOutcome } from "./merge";
import type { PostDiscord } from "./run";

/** Python `failed[:3]` (line 1489) — a cap on a report, not a filter. */
const NAME_CAP = 3;

/** The red-side colour from Python line 1497. */
const REVERT_COLOR = 0xe74c3c;

/** Python's `revert_merge(...)` call, as a seam. */
export type RevertPort = (args: RevertArgs) => Promise<RevertOutcome>;

/** Everything `verifyPendingSyncs` needs from the world. */
export type VerifyDeps = {
  api: GhClient;
  /**
   * The per-fork `enabled` flag, from `PR_AGENT_UPSTREAM_SYNC` at call time.
   *
   * A bare boolean rather than a whole `SyncConfig`: the watch resolves each
   * fork's config itself through `syncConfig(fork, repoOverrides, enabled)`, so
   * a `baseConfig` here would be read for `enabled` and ignored for everything
   * else — a field that looks load-bearing and is not. A `verify_ci: false`
   * override belongs in `repoOverrides`, which is what the Python's
   * `UPSTREAM_SYNC["repos"]` is.
   */
  enabled: boolean;
  /** Per-repo overrides, layered over the worker defaults per fork. */
  repoOverrides: RepoOverrides;
  /** Python `time.time()` (line 1469). */
  now: () => number;
  /** Python `save_sync_state` (state.ts), swappable for a test. */
  saveState: (state: SyncState) => void;
  /** Python `_sync_revert_merge` (merge.ts), swappable for a test. */
  revertMerge: RevertPort;
  postDiscord: PostDiscord;
};

/** The Python's `get_installation_token`-free token map: `{fork: token}`. */
export type TokenByRepo = Record<string, string>;

const asObject = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

/**
 * Python `verify_pending_syncs(state, token_by_repo, dry=False)` (lines
 * 1451-1517): "CI-verify merges we pushed directly. … Returns report lines."
 *
 * NEVER THROWS beyond what a caller must handle: `GhClient.request` already
 * never throws (github.ts exhausts its retries and returns `{status: 0,
 * data: {}}`), so a transport failure here degrades to "no tip", "no checks"
 * and therefore the patience path — the same as the Python, where `gh_api`
 * returns `(0, {})` on exhaustion.
 *
 * The `pending_verify` sha is the guard, not the branch name: a merge we did
 * not push has no `pending_verify`, so it is never a candidate for a revert.
 */
export async function verifyPendingSyncs(
  deps: VerifyDeps,
  state: SyncState,
  tokenByRepo: TokenByRepo,
  dry = false,
): Promise<string[]> {
  const lines: string[] = [];

  for (const fork of Object.keys(state)) {
    const entry = state[fork] as SyncEntry;
    const pending = pendingVerify(entry);
    // Python lines 1458-1459: no sha means no watch.
    if (!pending?.sha) continue;
    const token = tokenByRepo[fork] || ""; // Python line 1461
    if (!token) continue; // Python line 1462
    const cfg = syncConfig(fork, deps.repoOverrides, deps.enabled);
    const branch = pending.branch || "main"; // Python line 1465

    // (a) — clears in memory, deliberately does NOT save and does NOT report.
    if (!cfg.verify_ci || dry) {
      entry.pending_verify = null;
      continue;
    }

    const age = deps.now() - num(pending.pushed_at); // Python line 1469

    // (b) — the merge is KEPT; only the watch stops.
    if (age > cfg.verify_ci_max_age_h * 3600) {
      lines.push(
        `   ⌛ ${fork}: merge ${pending.sha.slice(0, 8)} unverified for ` +
          `${(age / 3600).toFixed(1)}h — keeping it, stopping the watch`,
      );
      entry.pending_verify = null;
      deps.saveState(state);
      continue;
    }

    // Python line 1476: the TIP of the branch, as a one-element list.
    const tipResult = await deps.api.request(
      "GET",
      `/repos/${fork}/commits/${branch}?per_page=1`,
      { token },
    );
    const tipList = Array.isArray(tipResult.data) ? tipResult.data : [];
    const tip = tipList.length ? String(asObject(tipList[0])?.sha ?? "") : "";

    // (c) — someone pushed on top of our merge. Not ours to revert.
    if (tip && tip !== pending.sha) {
      lines.push(
        `   ✓ ${fork}: ${branch} moved past our merge ` +
          `(${pending.sha.slice(0, 8)} → ${tip.slice(0, 8)}) — nothing to verify`,
      );
      entry.pending_verify = null;
      deps.saveState(state);
      continue;
    }

    const checksResult = await deps.api.request(
      "GET",
      `/repos/${fork}/commits/${pending.sha}/check-runs`,
      { token },
    );
    const checks = Array.isArray(asObject(checksResult.data)?.check_runs)
      ? (checksResult.data as any).check_runs
      : [];
    const failed = checks.filter((c: any) => c?.conclusion === "failure");
    const running = checks.filter((c: any) => c?.status !== "completed");

    // (d) — the only path that touches the branch.
    if (failed.length) {
      const names = failed
        .slice(0, NAME_CAP)
        .map((c: any) => (typeof c?.name === "string" ? c.name : "?"))
        .join(", ");
      const reverted = await deps.revertMerge({
        appToken: token,
        fork,
        branch,
        preMergeSha: pending.pre_merge_sha ?? "",
        reason: `CI failed: ${names}`,
      });
      lines.push(`   ↩️  ${fork}: ${reverted.detail}`);
      await deps.postDiscord(
        `↩️ Fork sync reverted: ${fork}`,
        [
          `CI failed at our merge commit \`${pending.sha.slice(0, 8)}\` (${names}).`,
          reverted.detail,
          `https://github.com/${fork}/commits/${branch}`,
        ],
        REVERT_COLOR,
      );
      entry.pending_verify = null;
      // Python line 1500: forgetting the merged sha is what makes the NEXT
      // tick retry this upstream tip instead of skipping it as handled.
      entry.last_merged_upstream_sha = "";
      deps.saveState(state);
      continue;
    }

    // (e) — no checks and still young. Do nothing at all, and do not save:
    // the check-runs may simply not have registered yet. The comparison is
    // `age < grace` (EXCLUSIVE), so exactly `grace` seconds old stops the watch.
    if (!checks.length) {
      if (age < cfg.no_ci_grace_s) continue;
      entry.pending_verify = null;
      deps.saveState(state);
      continue;
    }

    // (g) — still running; verify on a later tick.
    if (running.length) continue;

    // (h) — green.
    lines.push(
      `   ✅ ${fork}: merge ${pending.sha.slice(0, 8)} verified green ` +
        `(${checks.length} check(s))`,
    );
    entry.pending_verify = null;
    deps.saveState(state);
  }

  return lines;
}

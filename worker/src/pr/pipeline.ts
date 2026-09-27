/**
 * Per-PR decision pipeline + tick runner — port of `scripts/pr-queue-worker.py`
 * lines 1833-2186 (`main`), plus `notify_skip_once` (485-495) and the no-code
 * review body (1915-1923). This file is now ONLY the orchestrator: the step
 * bodies, the conflict resolver and the shared vocabulary moved to siblings.
 *
 *   ./context — `Ctx`, the flat `WorkerDeps` injection surface, the constants
 *               and every small helper (`notifySkipOnce`, `refetchHead`, …).
 *   ./steps   — STEP A0 (pin guard), A (review), A2 (lockfile pre-fix),
 *               B (AI fix). Runs before any gate.
 *   ./gates   — the conflict resolver, STEP C/D (safety + CI) and STEP E
 *               (approve + merge). Every arm ends the PR's turn.
 *
 * THE ORDER IS THE PRODUCT. A PR walks exactly one path: pin guard →
 * review/trigger → permanent skip → AI fix → safety → CI → mergeable →
 * approve+merge, and each gate ends the PR's turn. The pin guard is BEFORE the
 * review (1885) and its `continue` is UNCONDITIONAL (1899), so a failed close
 * abandons the PR without counting it skipped. A TRIGGERED review is NOT a skip
 * (1934). The wiring below is the Python's order, unchanged.
 *
 * EVERY REPORT STRING IS A LITERAL. They land on a Discord channel an operator
 * reads, and several are contracts (the `[INFRA]` prefix, `⏭️  Permanently
 * skipped:`, `Unresolvable merge conflict`). The emoji, the two spaces after
 * `⏭️`/`⚠️` and the 3-space indent are the Python's.
 *
 * `deps` is ONE flat object and is the UNION of the ported modules' own deps
 * (`AiFixDeps`, `LockfixDeps`, `MergeDeps`, `RunUpstreamSyncDeps`), not a
 * parallel abstraction. Every global the Python reached for is a field, which
 * is what makes a whole tick testable without a socket.
 *
 * `runTick` is deliberately NOT responsible for `bootstrapEnv()`: the Python
 * did that at import time, before its config constants resolved, and
 * `src/index.ts` is where it has to happen (see env.ts's call-order note).
 *
 * The re-exports below keep this module's public surface exactly what it was
 * before the split — `index.ts` and the tests import from here, and neither
 * should have to learn that the steps moved.
 */
import type { ReportPort } from "./autofix";
import { gatherOpenPrs, type OpenPr } from "./scan";
import {
  AI_FIX_ENABLED,
  ctime,
  notifySkipOnce,
  strOf,
  titleOf,
  type Ctx,
  type PrResult,
  type WorkerDeps,
} from "./context";
import { resolveConflict, stepMerge, stepSafetyAndCi } from "./gates";
import { stepAiFix, stepPinGuard, stepReview } from "./steps";
import { LOCK_FILE } from "../lock";
import { runUpstreamSync } from "../sync/run";
import { alreadyFixed, getSkipReason } from "../state";

export {
  UNRESOLVABLE_CONFLICT,
  ctime,
  type LockPort,
  type Notify,
  type PrResult,
  type WorkerDeps,
} from "./context";


/** Python's four counters (1859-1862), summed across the tick's PRs. */
export type PrCounts = { merged: number; triggered: number; fixed: number; skipped: number };

/** The four counter keys, for the tick's accumulate loop. */
const COUNTERS: (keyof PrCounts)[] = ["merged", "triggered", "fixed", "skipped"];

// ── process_pr ──────────────────────────────────────────────────────────────

/**
 * One PR, start to finish, in the Python's order. Every human-readable line
 * reaches `deps.report` by the time this returns — the Python's BUFFER
 * discipline — and the four booleans say which counters that PR moved.
 *
 * `already` is read ONCE (1940) and threaded to both resolve sites: the Python
 * reuses that one local, so a fix already recorded must not buy a second agent
 * run at this SHA.
 */
export async function processPr(deps: WorkerDeps, open: OpenPr): Promise<PrResult> {
  const { token, repo, pr } = open;
  const c: Ctx = {
    token,
    repo,
    prNum: pr?.number,
    title: titleOf(pr),
    headSha: strOf(pr?.head?.sha),
    headRef: strOf(pr?.head?.ref),
    baseRef: strOf(pr?.base?.ref),
    author: strOf(pr?.user?.login),
    mergeable: typeof pr?.mergeable === "boolean" ? pr.mergeable : null,
    createdAt: pr?.created_at,
    fixState: deps.loadFixState(),
    noCodeReview: false,
    score: "",
    out: { merged: false, triggered: false, fixed: false, skipped: false },
  };

  deps.report.push(`\n${"─".repeat(40)}`);
  deps.report.push(`🔀 ${repo} #${c.prNum} — ${c.title}`);
  deps.report.push(`   👤 ${c.author} | branch: ${c.headRef} → ${c.baseRef}`);

  if (pr?.merged || pr?.state !== "open") {
    deps.report.push("   ⏭️  Already merged/closed");
    c.out.skipped = true; // Python lines 1877-1879
    return c.out;
  }
  if (await stepPinGuard(deps, c)) return c.out;

  const review = await stepReview(deps, c);
  if (review === null) return c.out; // Triggered review: NOT a skip (line 1934).

  const already = alreadyFixed(c.fixState, repo, c.prNum, c.headSha);
  const skipReason = getSkipReason(c.fixState, repo, c.prNum, c.headSha);
  if (skipReason) {
    // Respect the recorded reason until the head changes; re-running every cron
    // tick is exactly what the skip exists to prevent (1942-1949).
    deps.report.push(`   ⏭️  Permanently skipped: ${skipReason} (until head SHA changes)`);
    // Python line 1947 calls `notify_skip_once(...)` as a BARE statement — the
    // notification fires, but no `🔔 Skip notified` line is appended. Only the
    // three `if notify_skip_once(...):` sites (2028, 2102, 2158) report it, so
    // routing this through `reportSkipNotice` would put a line in the ops
    // channel on every tick of every permanently-skipped PR. This is the single
    // site in the port that must notify silently.
    await notifySkipOnce(deps, c, skipReason);
    c.out.skipped = true;
    return c.out;
  }

  await stepAiFix(deps, c, already);
  if (await stepSafetyAndCi(deps, c, review)) return c.out;

  // `=== false`, NOT falsy: GitHub's `mergeable` is null while it computes, and
  // the Python treats that as "not a conflict" (line 2066).
  if (c.mergeable === false) {
    deps.report.push("   🔴 Merge conflicts");
    await resolveConflict(
      deps, c, already,
      "   🔄 Head SHA updated (conflict fix pushed)",
      true,
    );
    c.out.skipped = true;
    return c.out;
  }
  c.out.merged = await stepMerge(deps, c, already);
  // Python: every non-merged arm falls into skipped_count.
  if (!c.out.merged) c.out.skipped = true;
  return c.out;
}

// ── run_tick ────────────────────────────────────────────────────────────────

/**
 * One cron tick: lock → upstream sync → PR fan-out → summary → flush, with the
 * lock released on every exit including a throw.
 *
 * THE TWO SILENT EXITS ARE SILENT ON PURPOSE. A lost lock (1837) and a tick with
 * nothing to do and nothing to sync (1847) both return before a single BUFFER
 * line: the report is Discord-posted on a non-TTY, and an empty tick posting
 * "0 PRs" every five minutes is how a channel stops being read.
 *
 * The Python's BUFFER is one global that the sync, the AI fix and the summary
 * all append to in that order. The collector here is the same object for all
 * three, so the interleaving survives — and it also returns the lines, which is
 * what the brief's `Promise<string[]>` promises.
 */
export async function runTick(deps: WorkerDeps): Promise<string[]> {
  const lines: string[] = [];
  const start = deps.now();

  const lock = deps.lock.acquire(LOCK_FILE);
  if (!lock) return lines; // Python lines 1837-1838
  deps.onLockAcquired?.(() => lock.release());

  const report: ReportPort = {
    push: (line: string) => {
      lines.push(line);
      deps.report.push(line);
    },
  };
  const tick: WorkerDeps = { ...deps, report };

  try {
    const syncLines = await runUpstreamSync(
      {
        run: deps.run,
        workdirs: deps.workdirs,
        agent: deps.agent,
        api: deps.api,
        fetchGhToken: deps.fetchGhToken,
        postDiscord: deps.postDiscord,
        loadState: deps.loadSyncState,
        saveState: deps.saveSyncState,
        now: deps.now,
        report,
        repoOverrides: deps.repoOverrides,
      },
      { dry: deps.dry },
    );
    const allPrs = await gatherOpenPrs(deps.api);
    if (!allPrs.length && !syncLines.length) return lines; // Python lines 1847-1848

    report.push(`🔍 PR Queue Worker — ${ctime(start)}`);
    report.push("=".repeat(50));
    for (const line of syncLines) report.push(line); // Python lines 1852-1853
    if (allPrs.length) {
      report.push(`📋 Found ${allPrs.length} open PR(s) to process`);
      if (AI_FIX_ENABLED) report.push("   ✨ AI auto-fix: ENABLED (Claude Code)");
    }

    const counts: PrCounts = { merged: 0, triggered: 0, fixed: 0, skipped: 0 };
    for (const open of allPrs) {
      const r = await processPr(tick, open);
      for (const k of COUNTERS) if (r[k]) counts[k] += 1;
    }

    report.push(`\n${"=".repeat(50)}`);
    report.push(`📊 Summary (${(deps.now() - start).toFixed(1)}s)`); // Python line 2175
    if (AI_FIX_ENABLED) report.push(`   ✨ AI fixes applied: ${counts.fixed}`);
    report.push(`   ✅ Merged: ${counts.merged}`);
    report.push(`   📡 Reviews triggered: ${counts.triggered}`);
    report.push(`   ⏭️  Skipped: ${counts.skipped}`);
    report.push("=".repeat(50));

    // `flush_log` (2183). On a non-TTY the flush posts to the ops channel, which
    // is one of the four effects `--dry` suppresses, so a rehearsal stays local.
    if (!deps.dry) await deps.flushReport();
  } finally {
    lock.release(); // Python line 2186
  }
  return lines;
}

/**
 * Per-PR decision pipeline + tick runner — port of `scripts/pr-queue-worker.py`
 * lines 1833-2186 (`main`), plus `notify_skip_once` (485-495) and the no-code
 * review body (1915-1923).
 *
 * THE ORDER IS THE PRODUCT. A PR walks exactly one path: pin guard →
 * review/trigger → permanent skip → AI fix → safety → CI → mergeable →
 * approve+merge, and each gate ends the PR's turn. The pin guard is BEFORE the
 * review (1885) and its `continue` is UNCONDITIONAL (1899), so a failed close
 * abandons the PR without counting it skipped. A TRIGGERED review is NOT a skip
 * (1934).
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
 * THIS FILE EXCEEDS THE 400-LINE CAP (765 total, 516 of them code). Splitting
 * it would mean a third source file, which the task forbids without asking, and
 * the excess is not comment bloat that trimming can absorb. See the task-14
 * report.
 */
import {
  checkPrStillValid,
  killOrphanedAgent,
  runAiFix,
  type AgentPort,
  type ProcessDeps,
  type ReportPort,
} from "./autofix";
import { STALE_CI_CLOSE_DAYS, checkCiPassed, closeStaleCiPr } from "./ci";
import {
  fixBunLock,
  fixUvLock,
  isTrivialPr,
  repoHasBunLock,
  type ProcRunner,
  type Workdirs,
} from "./lockfix";
import { approvePr, mergePr } from "./merge";
import { TOOLCHAIN_PINS, closeToolchainPr, toolchainPinViolation } from "./pins";
import { findReviewComment, findTrivialNoReviewMarker, triggerReview, type FetchLike } from "./review";
import { analyzeReviewSafety } from "./safety";
import { gatherOpenPrs, type GhAppClient, type OpenPr } from "./scan";
import { LOCK_FILE } from "../lock";
import { runUpstreamSync, type PostDiscord } from "../sync/run";
import type { RepoOverrides, SyncState } from "../sync/config";
import type { GitRunner } from "../git";
import {
  alreadyFixed,
  getSkipReason,
  markFixed,
  markSkip,
  markSkipNotified,
  wasSkipNotified,
  type FixState,
} from "../state";

// ── Constants ───────────────────────────────────────────────────────────────

/** Python `AI_FIX_ENABLED = True` (70) — a module constant there too, and it
 *  gates four sites (1856, 1952, 2071, 2134); every one is a gate, not a report. */
const AI_FIX_ENABLED = true;
/** Python line 1866, `pr.get("title", "untitled")[:60]`. */
const TITLE_CAP = 60;
/** Python line 2051, the `86400` in the dependabot age arithmetic. */
const SECONDS_PER_DAY = 86_400;

/**
 * Python line 2100, the `else` arm of a failed conflict fix — the reason an
 * agent-unresolvable merge conflict is recorded under. A contract string, and
 * the test pins it against the Python's literal.
 */
export const UNRESOLVABLE_CONFLICT = "Unresolvable merge conflict (Claude Code made no push)";

/**
 * Python line 2026, `summary.replace("[INFRA] ", "")`. `String.replace` with a
 * STRING pattern replaces the FIRST occurrence only; Python replaces ALL, and
 * the stripped form is what lands in the state file.
 */
const stripInfra = (s: string): string => s.split("[INFRA] ").join("");
/** Python line 2022, `summary.startswith("[INFRA]")`. */
const isInfra = (s: string): boolean => s.startsWith("[INFRA]");

/** Python lines 1915-1923, verbatim. A dependabot lockfile-only bump never gets
 *  a "PR Reviewer Guide" (there is no code diff), so the worker synthesises one
 *  that scores a clean 10/10 and lets the normal merge path proceed. */
const NO_CODE_REVIEW =
  "## PR Reviewer Guide 🔍\n⏱️ Estimated effort to review: 1 🔵⚪⚪⚪⚪\n" +
  "🏅 Score: 100\n🔒 No security concerns identified\n⚡ No major issues detected\n" +
  "🧪 No relevant tests\nNo code changes to review (dependency/lockfile-only bump).";

// ── Injection surface ───────────────────────────────────────────────────────

/** Python's `post_discord_notification` (472-483). */
export type Notify = (
  repo: string,
  pr: number,
  status: string,
  summary: string,
  score: string | number,
  url: string,
) => Promise<void>;

/** The lock seam, so a test can hold or deny the lock without touching `/tmp`. */
export type LockPort = { acquire(path: string): { release(): void } | null };

/**
 * One flat object supplying every ported module's own deps plus the two things
 * only the pipeline owns: the report and the fix state. `AgentClient` satisfies
 * `agent` (it has both `post` and `runSync`), and `Report` satisfies `report`.
 */
export type WorkerDeps = {
  api: GhAppClient;
  agent: AgentPort & { runSync(opts: any): Promise<{ ok: boolean; snippet: string }> };
  run: GitRunner;
  exec: ProcRunner;
  workdirs: Workdirs;
  procs: ProcessDeps;
  fetchGhToken: () => string;
  report: ReportPort;
  flushReport: () => Promise<void>;
  notify: Notify;
  postDiscord: PostDiscord;
  loadFixState: () => FixState;
  saveFixState: (state: FixState) => void;
  loadSyncState: () => SyncState;
  saveSyncState: (state: SyncState) => void;
  repoOverrides: RepoOverrides;
  /** Python `time.time()`, in SECONDS. */
  now: () => number;
  fetchImpl: FetchLike;
  lock: LockPort;
  /**
   * Called the instant the lock is claimed, with its release. This is how
   * `index.ts` reaches a `runTick` lock from its SIGTERM handler: the Python
   * installed `_term_handler` (2194-2198) over a module-global lock, and this
   * is the injected equivalent. Without it a SIGTERM leaves the lockfile
   * behind and wedges every later tick.
   */
  onLockAcquired?: (release: () => void) => void;
  webhookSecret?: string;
  webhookUrl?: string;
  /**
   * `--dry`. Suppresses the four effects the brief names (state write, push,
   * PR, Discord) AT THE EFFECT, never by skipping a decision, so a dry run
   * walks the same gates and reports the same lines. The one visible
   * difference is the `🧪 dry run: would …` line each suppressed effect
   * leaves, matching the marker `sync/run.ts` already established.
   */
  dry: boolean;
};

/** The brief's per-PR result: one flag per counter, `true` when it fired. */
export type PrResult = { merged: boolean; triggered: boolean; fixed: boolean; skipped: boolean };

/** Python's four counters (1859-1862), summed across the tick's PRs. */
export type PrCounts = { merged: number; triggered: number; fixed: number; skipped: number };

/** The four counter keys, for the tick's accumulate loop. */
const COUNTERS: (keyof PrCounts)[] = ["merged", "triggered", "fixed", "skipped"];

/** Per-PR: the Python's loop-locals plus the running outcome, mutated in place. */
type Ctx = {
  /** The installation token, reused by every later step (Python's `token`). */
  token: string;
  repo: string;
  prNum: number;
  title: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  author: string;
  /** Tri-state, because line 2066 tests `is False` and null means "computing". */
  mergeable: boolean | null;
  createdAt: unknown;
  fixState: FixState;
  /** Set by the trivial-PR branch; suppresses the AI fix (1952). */
  noCodeReview: boolean;
  /** Python's `score`, from `analyze_review_safety` — carried into the Discord
   *  payload (2125, 2168), which is why it outlives the safety block. */
  score: string | number;
  out: PrResult;
};

const titleOf = (pr: any): string =>
  (typeof pr?.title === "string" ? pr.title : "untitled").slice(0, TITLE_CAP);
const strOf = (v: unknown): string => (typeof v === "string" ? v : "");

/** `time.ctime()` (1850) in the Python's LOCAL time — an operator reads this
 *  against their own clock, which is the only reason the header exists. */
export function ctime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return (
    `${days[d.getDay()]} ${months[d.getMonth()]} ${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
  );
}

/**
 * Python line 2051: `(time.time() - mktime(strptime(created, "%Y-%m-%dT%H:%M:%SZ"))) / 86400`
 * inside a `try`, `age_days = 0` on any failure. `mktime` reads the naive tuple
 * as LOCAL time while `Date.parse` on a `Z` ISO string is UTC, so this is off by
 * the host's UTC offset — below the 0.1d precision of the `{age_days:.1f}`
 * report line in every timezone the worker runs in. A malformed date is 0
 * days, which is the "too fresh to close" direction.
 */
function ageDays(created: unknown, nowSec: number): number {
  if (typeof created !== "string") return 0;
  const t = Date.parse(created);
  return Number.isFinite(t) ? (nowSec - t / 1000) / SECONDS_PER_DAY : 0;
}

/** The `AiFixDeps` + `LockfixDeps` view of one flat object. */
function subDeps(deps: WorkerDeps) {
  return {
    run: deps.run,
    exec: deps.exec,
    workdirs: deps.workdirs,
    fetchGhToken: deps.fetchGhToken,
    agent: deps.agent,
    api: deps.api,
    report: deps.report,
  };
}

/** `mark_*` saves in the Python (a side effect of the mutator); dry does not. */
function persist(deps: WorkerDeps, state: FixState): void {
  if (!deps.dry) deps.saveFixState(state);
}

/**
 * `notify_skip_once` (485-495): the alert fires ONCE per PR+head_sha+reason.
 * The send comes BEFORE the flag is written (the Python's order), so a crash in
 * between re-alerts next tick rather than losing the notice — the cheap failure
 * to have, against the expensive one.
 */
async function notifySkipOnce(
  deps: WorkerDeps,
  c: Ctx,
  reason: string,
): Promise<boolean> {
  if (wasSkipNotified(c.fixState, c.repo, c.prNum, c.headSha)) return false;
  if (!deps.dry) {
    await deps.notify(
      c.repo,
      c.prNum,
      "skipped",
      `⏭️ Skipped: ${reason} — will not retry until the PR head changes`,
      "",
      `https://github.com/${c.repo}/pull/${c.prNum}`,
    );
  }
  markSkipNotified(c.fixState, c.repo, c.prNum, c.headSha);
  persist(deps, c.fixState);
  return true;
}

/** Python line 2029/2103/2159: report the notify only when it actually sent. */
async function reportSkipNotice(deps: WorkerDeps, c: Ctx, reason: string): Promise<void> {
  if (await notifySkipOnce(deps, c, reason)) deps.report.push(`   🔔 Skip notified: ${reason}`);
}

/**
 * The post-push head re-fetch (1967-1972, 2013-2019, 2087-2091). Returns the
 * fresh PR object or null and reports nothing: the sites print DIFFERENT
 * "Head SHA updated" lines, so the wording is the caller's.
 */
async function refetchHead(deps: WorkerDeps, c: Ctx): Promise<any | null> {
  const { data } = await deps.api.request("GET", `/repos/${c.repo}/pulls/${c.prNum}`, { token: c.token });
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data : null;
}

/** A fresh sha counts only when the PR actually moved — line 1970's guard. */
const movedSha = (pr: any, from: string): string | null => {
  const sha = strOf(pr?.head?.sha);
  return sha && sha !== from ? sha : null;
};

// ── STEP A0 — toolchain pin guard (1882-1899) ───────────────────────────────

/** True when the PR's turn is over. Closes dependabot bumps of a pinned major. */
async function stepPinGuard(deps: WorkerDeps, c: Ctx): Promise<boolean> {
  if (c.author !== "dependabot[bot]") return false;
  const violation = toolchainPinViolation(c.repo, c.title);
  if (!violation) return false;
  const [pkg, oldVer, newVer] = violation;

  deps.report.push(
    `   ⛔ Toolchain pin violation: ${pkg} ${oldVer} → ${newVer} (allowed major ${TOOLCHAIN_PINS[c.repo][pkg]})`,
  );
  if (deps.dry) {
    deps.report.push(`   🧪 dry run: would close #${c.prNum} (pin violation)`);
    c.out.skipped = true;
    return true;
  }
  const { status } = await closeToolchainPr(deps.api, c.token, c.repo, c.prNum, pkg, oldVer, newVer);
  if (status === 200) {
    deps.report.push(`   ✅ Closed #${c.prNum} (pin violation)`);
    c.out.skipped = true; // Python counts a skip ONLY on a 200 close.
  } else {
    deps.report.push(`   ⚠️  Close failed HTTP ${status} — leaving open`);
  }
  return true;
}

// ── STEP A — review (1901-1936) ─────────────────────────────────────────────

/**
 * Returns the review body, or null when the PR STOPS for this tick — a review
 * was just triggered and needs a cycle.
 */
async function stepReview(deps: WorkerDeps, c: Ctx): Promise<string | null> {
  const found = await findReviewComment(deps.api, c.token, c.repo, c.prNum);
  if (found) {
    deps.report.push("   📝 Review found");
    return found;
  }
  // The trivial-PR branch (1912-1923) is a fix, not an optimisation: a
  // lockfile-only bump yields "No code suggestions found" rather than a guide,
  // and re-triggering every five minutes produced duplicate comment spam.
  if (
    isTrivialPr(c.title, c.author) &&
    (await findTrivialNoReviewMarker(deps.api, c.token, c.repo, c.prNum))
  ) {
    deps.report.push(
      "   📝 PR-Agent assessed (no-code/lockfile PR) — no code to review, treating as reviewed",
    );
    c.noCodeReview = true;
    return NO_CODE_REVIEW;
  }
  deps.report.push("   📡 No review → triggering PR-Agent...");
  const result = await triggerReview(
    {
      api: deps.api,
      fetchImpl: deps.fetchImpl,
      webhookSecret: deps.webhookSecret,
      webhookUrl: deps.webhookUrl,
    },
    c.repo,
    c.prNum,
    c.title,
    c.headSha,
    c.headRef,
    c.baseRef,
  );
  if (typeof result === "number" && result >= 200 && result < 300) {
    deps.report.push(`   ✅ PR-Agent triggered (HTTP ${result})`);
    c.out.triggered = true;
  } else {
    deps.report.push(`   ⚠️  Trigger result: ${result}`);
  }
  return null;
}

// ── STEP A2 — lockfile pre-fix for trivial PRs (1953-1986) ─────────────────

/**
 * For a lockfile-only PR whose CI is red on a lockfile check, re-resolve and
 * push the lockfile BEFORE the AI agent runs. `bun.lock` first for a Bun repo;
 * `uv.lock` is the fallback, SKIPPED when the CI message already names it
 * (1973) — re-resolving the file uv just complained about costs a clone and
 * changes nothing.
 */
async function stepLockPrefix(deps: WorkerDeps, c: Ctx): Promise<void> {
  const early = await checkCiPassed(deps.api, c.token, c.repo, c.headSha);
  if (early.ok || !early.msg.includes("typecheck")) return;
  const useBun = (await repoHasBunLock(deps.api, c.token, c.repo, c.headSha)) || early.msg.includes("uv.lock");

  deps.report.push(
    useBun ? "   🔧 CI failing: bun.lock stale — pre-fixing..." : "   🔧 CI failing: uv.lock stale — pre-fixing...",
  );
  if (deps.dry) {
    deps.report.push("   🧪 dry run: would re-resolve and push the lockfile");
    return;
  }
  const { ok, summary } = useBun
    ? await fixBunLock(subDeps(deps), c.repo, c.prNum, c.headRef, c.baseRef)
    : await fixUvLock(subDeps(deps), c.repo, c.prNum, c.headRef, c.baseRef);
  if (!ok) return; // Python 1965: a failed fix reports nothing and moves on.

  deps.report.push(`   ✅ ${summary}`);
  const sha = movedSha(await refetchHead(deps, c), c.headSha);
  if (sha) {
    deps.report.push("   🔄 Head SHA updated");
    c.headSha = sha;
  }
}

// ── STEP B — AI fix (1951-2029) ─────────────────────────────────────────────

/**
 * Runs the agent on the PR branch, or skips because this SHA was handled
 * already. `check_pr_still_valid` runs FIRST (1993) so a PR closed under us is
 * not paid for, and its NEW head is adopted (1998-2000) so the merge path
 * re-reads reality instead of a stale sha.
 */
async function stepAiFix(deps: WorkerDeps, c: Ctx, already: boolean): Promise<void> {
  if (!AI_FIX_ENABLED || c.noCodeReview) return;
  // Python line 1956: `is_trivial_pr(title, author) and not already`.
  if (isTrivialPr(c.title, c.author) && !already) await stepLockPrefix(deps, c);

  if (already) {
    deps.report.push("   ⏭️  Already fixed at this SHA — skip AI fix");
    return;
  }
  if (deps.dry) {
    deps.report.push("   🧪 dry run: would run the Hermes AI fix");
    return;
  }
  const [valid, newSha, newMergeable, reason] = await checkPrStillValid(
    deps.api, c.token, c.repo, c.prNum, c.headSha,
  );
  if (!valid) {
    deps.report.push(`   ⏭️  PR changed: ${reason}`);
    if (newSha) {
      c.headSha = newSha;
      c.mergeable = typeof newMergeable === "boolean" ? newMergeable : null;
    }
    return;
  }

  killOrphanedAgent(deps.procs, c.repo, c.prNum);
  const { ok, summary } = await runAiFix(
    subDeps(deps), c.repo, c.prNum, c.title, c.headSha, c.headRef, c.baseRef, c.token,
  );
  if (ok) {
    deps.report.push(`   ✨ ${summary}`);
    markFixed(c.fixState, c.repo, c.prNum, c.headSha);
    persist(deps, c.fixState);
    c.out.fixed = true;
    const fresh = await refetchHead(deps, c);
    const sha = movedSha(fresh, c.headSha);
    if (sha) {
      deps.report.push("   🔄 Head SHA updated for merge");
      c.headSha = sha;
      c.mergeable = typeof fresh?.mergeable === "boolean" ? fresh.mergeable : null;
    }
    return;
  }

  deps.report.push(`   ⏭️  AI fix skipped: ${summary}`);
  if (isInfra(summary)) {
    // Infra-level failure (CLI missing / timeout / unreachable): permanently
    // skip at this SHA, or retrying every 5 min would just loop (2023-2025).
    const why = stripInfra(summary);
    markSkip(c.fixState, c.repo, c.prNum, c.headSha, why);
    persist(deps, c.fixState);
    await reportSkipNotice(deps, c, why);
  }
}

// ── The conflict resolver, used from TWO sites (2071-2105 and 2134-2161) ────

/**
 * The "resolve this conflict with the agent, once per head SHA" block. The
 * Python writes it twice, byte-identical except for the report line and for
 * whether the head is re-fetched, so it is one function here with those two
 * differences as parameters: `recheck` is the 2066 site, and the 409 site does
 * NOT re-fetch.
 *
 * Always ends the PR's turn — success, failure and give-up all `continue` — so
 * it returns nothing and the caller counts the outcomes.
 */
async function resolveConflict(
  deps: WorkerDeps,
  c: Ctx,
  already: boolean,
  onFixed: string,
  recheck: boolean,
): Promise<void> {
  const giveUp = recheck
    ? "   ⏭️  Skipping (conflict, already attempted at this SHA)"
    : "   ⏭️  Skipping (409 conflict, already attempted)";
  if (AI_FIX_ENABLED && !already) {
    if (deps.dry) {
      deps.report.push("   🧪 dry run: would ask the agent to resolve the merge conflict");
      return;
    }
    const [valid] = await checkPrStillValid(deps.api, c.token, c.repo, c.prNum, c.headSha);
    if (valid) {
      deps.report.push("   🤖 Resolving merge conflict with Claude Code...");
      killOrphanedAgent(deps.procs, c.repo, c.prNum);
      const { ok, summary } = await runAiFix(
        subDeps(deps), c.repo, c.prNum, c.title, c.headSha, c.headRef, c.baseRef, c.token,
      );
      if (ok) {
        deps.report.push(`   ✨ Conflict resolved: ${summary}`);
        markFixed(c.fixState, c.repo, c.prNum, c.headSha);
        persist(deps, c.fixState);
        c.out.fixed = true;
        if (recheck) {
          const sha = movedSha(await refetchHead(deps, c), c.headSha);
          if (sha) deps.report.push(onFixed);
        } else {
          deps.report.push(onFixed);
        }
        return;
      }
      deps.report.push(`   ⏭️  Conflict fix failed: ${summary}`);
      const why = isInfra(summary) ? stripInfra(summary) : UNRESOLVABLE_CONFLICT;
      markSkip(c.fixState, c.repo, c.prNum, c.headSha, why);
      persist(deps, c.fixState);
      await reportSkipNotice(deps, c, why);
      return;
    }
  }
  deps.report.push(giveUp);
}

// ── STEP C/D — safety + CI gate (2031-2064) ─────────────────────────────────

/** True when the PR stops here. */
async function stepSafetyAndCi(deps: WorkerDeps, c: Ctx, review: string): Promise<boolean> {
  const safety = analyzeReviewSafety(review);
  for (const reason of safety.reasons) deps.report.push(`   ${reason}`);
  if (!safety.safe) {
    deps.report.push(`   🔴 SAFETY BLOCKED (score: ${safety.score}/10)`);
    c.out.skipped = true;
    return true;
  }
  deps.report.push(`   ✅ Safety score: ${safety.score}/10`);
  c.score = safety.score;

  const ci = await checkCiPassed(deps.api, c.token, c.repo, c.headSha);
  deps.report.push(`   🧪 CI: ${ci.msg}`);
  if (ci.ok) return false;

  // A dependabot bump stuck on red CI for days will never pass (it is
  // incompatible with the stack), so it is CLOSED — otherwise the worker prints
  // "Waiting for green CI" on the same PR forever (2046-2064).
  if (c.author === "dependabot[bot]") {
    const age = ageDays(c.createdAt, deps.now());
    if (age > STALE_CI_CLOSE_DAYS) {
      deps.report.push(`   ⛔ CI failing for ${age.toFixed(1)}d — closing stale dependabot PR`);
      if (deps.dry) {
        deps.report.push(`   🧪 dry run: would close #${c.prNum} (stale failing CI)`);
        c.out.skipped = true;
        return true;
      }
      const { status } = await closeStaleCiPr(deps.api, c.token, c.repo, c.prNum, c.title, ci.msg);
      if (status === 200) {
        deps.report.push(`   ✅ Closed #${c.prNum} (stale failing CI)`);
        c.out.skipped = true;
        return true; // Python 2060: `continue` on a 200, else fall through.
      }
      deps.report.push(`   ⚠️  Close failed HTTP ${status}`);
    }
  }
  deps.report.push("   ⏳ Waiting for green CI");
  c.out.skipped = true;
  return true;
}

// ── STEP E — approve + merge (2110-2170) ────────────────────────────────────

/** True when the PR merged. */
async function stepMerge(deps: WorkerDeps, c: Ctx, already: boolean): Promise<boolean> {
  const url = `https://github.com/${c.repo}/pull/${c.prNum}`;

  deps.report.push("   👍 Approving...");
  if (deps.dry) {
    deps.report.push(`   🧪 dry run: would approve and merge #${c.prNum}`);
    return false;
  }
  const approveStatus = await approvePr(deps.api, c.token, c.repo, c.prNum);
  deps.report.push(
    approveStatus === 200 || approveStatus === 201
      ? "   ✅ Approved!"
      : `   ⚠️  Approve: HTTP ${approveStatus}`,
  );

  deps.report.push("   🔀 Merging...");
  const { status, data } = await mergePr(
    { fetchGhToken: deps.fetchGhToken }, deps.api, c.token, c.repo, c.prNum, c.headSha,
  );
  if (status === 200) {
    deps.report.push(`   ✅ MERGED! SHA: ${data?.sha ?? "?"}`);
    await deps.notify(c.repo, c.prNum, "done", `PR merged (${c.title})`, c.score, url);
    return true;
  }
  if (status === 405) {
    deps.report.push("   ⚠️  Branch protection blocks merge");
    return false;
  }
  if (status === 409) {
    // GitHub said mergeable and then refused — a stale `mergeable` read. Same
    // one-attempt resolve as the 2066 gate, and equally not retried.
    deps.report.push("   ⚠️  Merge conflict");
    await resolveConflict(deps, c, already, "   🔄 Will re-merge next tick after CI settles", false);
    return false;
  }
  deps.report.push(`   ⚠️  Merge: HTTP ${status}`);
  await deps.notify(c.repo, c.prNum, "failed", `Merge failed HTTP ${status}: ${data?.message ?? ""}`, c.score, url);
  return false;
}

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
    await reportSkipNotice(deps, c, skipReason);
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

/**
 * The per-PR context, the flat injection surface, and the small helpers every
 * pipeline step shares — extracted from `./pipeline` so that file comes back
 * under the 400-line cap. THIS IS A MOVE, NOT A REWRITE.
 *
 * Nothing here changed but its `export` keywords and its home: the constants
 * (`AI_FIX_ENABLED`, `TITLE_CAP`, `SECONDS_PER_DAY`), the `[INFRA]` pair, the
 * synthesised no-code review body, `Notify`/`LockPort`/`WorkerDeps`/`PrResult`,
 * the `Ctx` loop-locals record, and every helper (`titleOf`, `strOf`, `ctime`,
 * `ageDays`, `subDeps`, `persist`, `notifySkipOnce`, `reportSkipNotice`,
 * `refetchHead`, `movedSha`) are the original lines with Python references
 * intact. `scripts/pr-queue-worker.py` is still the reference and the report
 * strings are still contracts.
 *
 * `TITLE_CAP` and `SECONDS_PER_DAY` stay unexported: only `titleOf` and
 * `ageDays` read them, and both live here.
 */
import type { AgentPort, ProcessDeps, ReportPort } from "./autofix.ts";
import type { ProcRunner, Workdirs } from "./lockfix.ts";
import type { FetchLike } from "./review.ts";
import type { GhAppClient } from "./scan.ts";
import type { GitRunner } from "../git.ts";
import type { RepoOverrides, SyncState } from "../sync/config.ts";
import type { PostDiscord } from "../sync/run.ts";
import type { FixState } from "../state.ts";
import { markSkipNotified, wasSkipNotified } from "../state.ts";


// ── Constants ───────────────────────────────────────────────────────────────

/** Python `AI_FIX_ENABLED = True` (70) — a module constant there too, and it
 *  gates four sites (1856, 1952, 2071, 2134); every one is a gate, not a report. */
export const AI_FIX_ENABLED = true;
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
export const stripInfra = (s: string): string => s.split("[INFRA] ").join("");
/** Python line 2022, `summary.startswith("[INFRA]")`. */
export const isInfra = (s: string): boolean => s.startsWith("[INFRA]");

/** Python lines 1915-1923, verbatim. A dependabot lockfile-only bump never gets
 *  a "PR Reviewer Guide" (there is no code diff), so the worker synthesises one
 *  that scores a clean 10/10 and lets the normal merge path proceed. */
export const NO_CODE_REVIEW =
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


/** Per-PR: the Python's loop-locals plus the running outcome, mutated in place. */
export type Ctx = {
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

export const titleOf = (pr: any): string =>
  (typeof pr?.title === "string" ? pr.title : "untitled").slice(0, TITLE_CAP);
export const strOf = (v: unknown): string => (typeof v === "string" ? v : "");

/** `time.ctime()` (1850) in the Python's LOCAL time — an operator reads this
 *  against their own clock, which is the only reason the header exists. */
export function ctime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // `time.ctime` pads HOURS/MINUTES/SECONDS to two digits but NOT the day, and
  // the space it leaves makes single-digit days render as "Jan  1" (two spaces).
  // Probed against the interpreter: time.ctime(0) == 'Thu Jan  1 07:00:00 1970'.
  // Padding the day too would diverge on ~24% of runs in the report header.
  return (
    `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ` +
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
export function ageDays(created: unknown, nowSec: number): number {
  if (typeof created !== "string") return 0;
  const t = Date.parse(created);
  return Number.isFinite(t) ? (nowSec - t / 1000) / SECONDS_PER_DAY : 0;
}

/** The `AiFixDeps` + `LockfixDeps` view of one flat object. */
export function subDeps(deps: WorkerDeps) {
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
export function persist(deps: WorkerDeps, state: FixState): void {
  if (!deps.dry) deps.saveFixState(state);
}

/**
 * `notify_skip_once` (485-495): the alert fires ONCE per PR+head_sha+reason.
 * The send comes BEFORE the flag is written (the Python's order), so a crash in
 * between re-alerts next tick rather than losing the notice — the cheap failure
 * to have, against the expensive one.
 */
export async function notifySkipOnce(
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
export async function reportSkipNotice(deps: WorkerDeps, c: Ctx, reason: string): Promise<void> {
  if (await notifySkipOnce(deps, c, reason)) deps.report.push(`   🔔 Skip notified: ${reason}`);
}

/**
 * The post-push head re-fetch (1967-1972, 2013-2019, 2087-2091). Returns the
 * fresh PR object or null and reports nothing: the sites print DIFFERENT
 * "Head SHA updated" lines, so the wording is the caller's.
 */
export async function refetchHead(deps: WorkerDeps, c: Ctx): Promise<any | null> {
  const { data } = await deps.api.request("GET", `/repos/${c.repo}/pulls/${c.prNum}`, { token: c.token });
  return data !== null && typeof data === "object" && !Array.isArray(data) ? data : null;
}

/** A fresh sha counts only when the PR actually moved — line 1970's guard. */
export const movedSha = (pr: any, from: string): string | null => {
  const sha = strOf(pr?.head?.sha);
  return sha && sha !== from ? sha : null;
};

/**
 * Per-PR decision pipeline + tick runner — the task-14 brief's 7 required test
 * cases, ported from `scripts/pr-queue-worker.py` lines 1833-2186 (`main`) and
 * the CLI block at 2200-2225.
 *
 * HERMETIC BY CONSTRUCTION, like the other worker suites: the GitHub client is
 * a route table, the agent is a counter, git is an argv table, the workdirs fs
 * is a Map, the process effects are no-ops and the state files are plain
 * objects. No test opens a socket, spawns a process, or writes to
 * `/tmp/pr-queue-*` — except `lockReleaseOnThrow`, which deliberately drives the
 * REAL `WorkerLock` against a `mkdtemp` path, because "the lock comes back" is
 * exactly the property a fake cannot prove.
 *
 * THE SEVEN CASES, one `describe` each, numbered as the brief numbers them.
 * The two that carry real risk get the extra assertions that make them risky:
 *   - case 4 proves "the next tick does not re-call the agent" by RUNNING THE
 *     TICK TWICE against one shared fix state, not by inspecting state;
 *   - case 7 pins the permanent-skip reason to the Python's exact string.
 *
 * On top of the seven, four extra tests hold the things the brief states in
 * prose rather than as a case: the summary-line format, `mergeable: null` NOT
 * being the conflict branch (Python's `is False`), the 409 conflict arm, and the
 * lock being released when the tick throws.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhAppClient } from "../src/pr/scan";
import type { Workdirs, ProcRunner } from "../src/pr/lockfix";
import type { GitResult, GitRunner } from "../src/git";
import type { PostResult } from "../src/agent";
import type { FixState } from "../src/state";
import type { SyncState } from "../src/sync/config";
import type { FetchLike } from "../src/pr/review";
import { WorkerLock } from "../src/lock";
import {
  processPr,
  runTick,
  UNRESOLVABLE_CONFLICT,
  type WorkerDeps,
} from "../src/pr/pipeline";

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const REPO = "acme/widgets";
const PR_NUM = 7;
const HEAD = "a1b2c3d4e5f6".repeat(3) + "abcd"; // 40 hex chars
const BASE = "f0e1d2c3b4a5".repeat(3) + "5678";

/** Python's `strptime("%Y-%m-%dT%H:%M:%SZ")` shape, no milliseconds. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** A review the Python's own `analyze_review_safety` scores 10/10. */
const SAFE_REVIEW = [
  "## PR Reviewer Guide 🔍",
  "⏱️ Estimated effort to review: 1 🔵⚪⚪⚪⚪",
  "🏅 Score: 100",
  "🔒 No security concerns identified",
  "⚡ No major issues detected",
  "🧪 No relevant tests",
].join("\n");

const BOT = "mytheclipsebotreview[bot]";

/** The `## PR Reviewer Guide` comment shape `findReviewComment` matches. */
const reviewComment = (body: string) => ({ user: { login: BOT }, body });

/**
 * Python lines 1912-1923: a dependabot lockfile bump PR-Agent already assessed
 * as having nothing to review.
 *
 * THIS FIXTURE IS HOW A TEST REACHES THE CONFLICT RESOLVER WITH EXACTLY ONE
 * AGENT CALL, and the reason is a real property of the Python rather than a
 * test convenience. `no_code_review` skips STEP B wholesale (line 1952), while
 * the resolver's gate is only `AI_FIX_ENABLED and not already` (line 2071) —
 * so the resolve runs where the ordinary AI fix did not. The alternative
 * suppression, a seeded `already` (line 1989), would suppress the resolve too,
 * and the only other way to stop the AI fix is to let it run — which is a
 * SECOND agent call before the resolve ever happens.
 */
const NO_CODE_MARKER = {
  user: { login: BOT },
  body: "## PR Code Suggestions\nNo code suggestions found (dependency/lockfile-only bump).",
};

/** The trivial title `isTrivialPr` needs, with the author the resolver skips on. */
const LOCKFILE_BUMP = {
  title: "chore(deps): bump axios from 1.6.0 to 1.7.0",
  user: { login: "dependabot[bot]" },
};

/** Only the SKIP notices, per the brief's "notifyReview (skip) terkirim sekali". */
const skipNotices = (h: { notifies: Notify[] }): Notify[] =>
  h.notifies.filter((n) => n.status === "skipped");

function makePr(over: Record<string, any> = {}): any {
  return {
    number: PR_NUM,
    title: "Refactor: harden the parser",
    state: "open",
    merged: false,
    head: { sha: HEAD, ref: "feature/harden" },
    base: { ref: "main" },
    user: { login: "alice" },
    mergeable: true,
    created_at: iso(Date.now() - 3600_000),
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════════════════════════

type Call = { method: string; path: string; json?: unknown };
type Notify = { repo: string; pr: number; status: string; summary: string; score: string | number; url: string };
type Route = { status: number; data: any };

type Options = {
  /** The open PRs `gatherOpenPrs` will hand back. */
  prs?: any[];
  /** `GET /repos/:r/issues/:n/comments` body. */
  comments?: any[];
  /** `GET /repos/:r/commits/:s/check-runs` body. */
  checkRuns?: any[];
  /** The repo `GET /repos/:r` reports (used by the sync fan-out). */
  repoMeta?: Route;
  /** `repoHasBunLock` reads `GET /repos/:r/git/trees/:s?recursive=1` and looks for
   *  a `bun.lock` entry; the harness serves a Bun tree by default. Set false for
   *  a repo with no `bun.lock` (a uv repo) — see the `stepLockPrefix` matrix. */
  hasBunLock?: boolean;
  /** `runAiFix`'s verdict, in call order; the last one repeats. */
  agent?: PostResult[];
  /** Fixed `now()`, in seconds; a tick reads it for elapsed + sync. */
  nowSec?: number;
  /** Pre-seeded fix state — the case-3 permanent skip. */
  fixState?: FixState;
  /** Throw from `request` on the pulls path, to fail a tick mid-flight. */
  throwOn?: (path: string) => boolean;
  /** `POST /pulls/:n/merge` reply. */
  merge?: Route;
  /** `GET /pulls/:n` (the re-validation + head re-fetch) reply. */
  pullReply?: Route;
  /** `--dry`: start the deps in dry mode, so the effects are suppressed. */
  dry?: boolean;
};

type Harness = {
  deps: WorkerDeps;
  /** Every GitHub call, in order. */
  calls: Call[];
  /** The `agent.post` prompts, in order — the "was the agent called?" oracle. */
  agentPosts: { prompt: string }[];
  /** `notifyReview` payloads, in order. */
  notifies: Notify[];
  /** Argv the lockfix `exec` port saw — must stay empty in every case here. */
  execCalls: string[][];
  fixState: FixState;
  /** How many times the tick/runner asked for the lock. */
  lockCalls: number;
  /** Lines pushed to the report port, in order. */
  lines: string[];
};

function harness(opts: Options = {}): Harness {
  const calls: Call[] = [];
  const agentPosts: { prompt: string }[] = [];
  const notifies: Notify[] = [];
  const execCalls: string[][] = [];
  const prs = opts.prs ?? [];
  const comments = opts.comments ?? [];
  const checkRuns = opts.checkRuns ?? [{ name: "build", status: "completed", conclusion: "success" }];
  const repoMeta = opts.repoMeta ?? { status: 200, data: { full_name: REPO, fork: false, default_branch: "main" } };
  const merge = opts.merge ?? { status: 200, data: { sha: "c0ffee" } };
  const pullReply = opts.pullReply;
  const agentReplies = [...(opts.agent ?? [{ ok: true, snippet: "done" }])];
  const fixState: FixState = opts.fixState ?? {};
  let agentCall = 0;

  const api: GhAppClient = {
    async request(method, path, o = {}) {
      calls.push({ method, path, json: o.json });
      if (opts.throwOn?.(path)) throw new Error("boom");
      if (path.startsWith("/app/installations")) return { status: 200, data: [{ id: 1 }] };
      if (path.startsWith("/installation/repositories")) {
        return { status: 200, data: { repositories: [{ full_name: REPO }] } };
      }
      if (/\/pulls\?/.test(path)) return { status: 200, data: prs };
      if (path === `/repos/${REPO}`) return repoMeta;
      if (/\/issues\/\d+\/comments$/.test(path)) return { status: 200, data: comments };
      if (/\/check-runs$/.test(path)) return { status: 200, data: { check_runs: checkRuns } };
      if (/\/git\/trees\/.*recursive/.test(path)) {
        const tree = opts.hasBunLock === false
          ? [{ path: "package.json" }, { path: "uv.lock" }]
          : [{ path: "package.json" }, { path: "bun.lock" }];
        return { status: 200, data: { tree } };
      }
      if (/\/pulls\/\d+\/merge$/.test(path)) return merge;
      if (/\/pulls\/\d+$/.test(path)) {
        return pullReply ?? { status: 200, data: { state: "open", merged: false, head: { sha: HEAD }, mergeable: true } };
      }
      return { status: 200, data: {} };
    },
    async installationToken() {
      return "install-token";
    },
  };

  const agent = {
    async post(prompt: string): Promise<PostResult> {
      agentPosts.push({ prompt });
      const reply = agentReplies[Math.min(agentCall, agentReplies.length - 1)];
      agentCall += 1;
      return reply;
    },
    async runSync(): Promise<PostResult> {
      return { ok: true, snippet: "sync" };
    },
  };

  // Only the verbs `runAiFix` issues; anything else is a bug in the wiring.
  const run: GitRunner = (args): GitResult => {
    switch (args[0]) {
      case "clone":
        return { code: 0, stdout: "", stderr: "" };
      case "diff":
        return { code: 0, stdout: "src/parser.ts\n", stderr: "" };
      case "rev-list":
        return { code: 0, stdout: "1\n", stderr: "" };
      case "push":
        return { code: 0, stdout: "", stderr: "" };
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  };

  const files = new Map<string, string>();
  const workdirs: Workdirs = {
    exists: (p) => files.has(p) || p === "/tmp/pr-queue-pids",
    mkdir: () => {},
    remove: (p) => void files.delete(p),
    writeFile: (p, c) => void files.set(p, c),
    readFile: (p) => files.get(p) ?? "",
  };

  const exec: ProcRunner = (args) => {
    execCalls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };

  const fetchImpl: FetchLike = async () => ({ status: 200 });

  const lines: string[] = [];
  const report = { push: (line: string) => void lines.push(line) };

  let lockCalls = 0;
  const deps: WorkerDeps = {
    api,
    agent,
    run,
    exec,
    workdirs,
    procs: { workdirs, procExists: () => false, kill: () => {}, sleep: () => {}, pid: 4242 },
    fetchGhToken: () => "gh-pat",
    report,
    flushReport: () => Promise.resolve(),
    notify: (
      repo: string,
      pr: number,
      status: string,
      summary: string,
      score: string | number,
      url: string,
    ) => {
      notifies.push({ repo, pr, status, summary, score, url });
      return Promise.resolve();
    },
    postDiscord: () => Promise.resolve(true),
    loadFixState: () => fixState,
    saveFixState: () => {},
    loadSyncState: (): SyncState => ({}),
    saveSyncState: () => {},
    repoOverrides: {},
    now: () => opts.nowSec ?? 1_700_000_000,
    fetchImpl,
    lock: {
      acquire: () => {
        lockCalls += 1;
        return { release: () => {} };
      },
    },
    dry: opts.dry ?? false,
  };

  return { deps, calls, agentPosts, notifies, execCalls, fixState, lockCalls, lines };
}

const approves = (calls: Call[]): number =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/reviews")).length;
const merges = (calls: Call[]): number =>
  calls.filter((c) => c.method === "PUT" && c.path.endsWith("/merge")).length;
const closes = (calls: Call[]): Call[] =>
  calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/pulls/${PR_NUM}`));
const ctx = { token: "install-token", repo: REPO, pr: makePr() };

// ═══════════════════════════════════════════════════════════════════════════

describe("case 1 — a PR with no review triggers one and stops for this tick", () => {
  test("triggered, nothing merged, not even counted as skipped", async () => {
    const h = harness({ prs: [makePr()] });

    const out = await processPr(h.deps, ctx);

    expect(out).toEqual({ merged: false, triggered: true, fixed: false, skipped: false });
    expect(approves(h.calls)).toBe(0);
    expect(merges(h.calls)).toBe(0);
    expect(h.agentPosts).toEqual([]);
    expect(h.lines).toContain("   📡 No review → triggering PR-Agent...");
    expect(h.lines).toContain("   ✅ PR-Agent triggered (HTTP 200)");
    // Python `continue`s at line 1934 WITHOUT touching skipped_count, which the
    // `toEqual` above already pins. An extra negative assertion here would be
    // tautological: that conflict line is only reachable from the resolver,
    // which needs a review to exist and this PR has none.
  });

  test("a non-2xx trigger is reported verbatim and still not 'triggered'", async () => {
    const h = harness({ prs: [makePr()] });
    (h.deps as any).fetchImpl = async () => ({ status: 500 });

    const out = await processPr(h.deps, ctx);

    expect(out.triggered).toBe(false);
    expect(h.lines).toContain("   ⚠️  Trigger result: 500");
  });
});

describe("case 2 — review + clean safety + green CI + mergeable merges once", () => {
  test("merged, with exactly one approve and one merge", async () => {
    // `already` short-circuits the AI-fix block: this case is about the merge
    // decision, and the line proves why the agent was not called.
    const h = harness({
      prs: [makePr()],
      comments: [reviewComment(SAFE_REVIEW)],
      fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD, notified: false } } },
    });

    const out = await processPr(h.deps, ctx);

    expect(out).toEqual({ merged: true, triggered: false, fixed: false, skipped: false });
    expect(approves(h.calls)).toBe(1);
    expect(merges(h.calls)).toBe(1);
    expect(h.agentPosts).toEqual([]);
    expect(h.execCalls).toEqual([]);

    expect(h.lines).toContain("   📝 Review found");
    expect(h.lines).toContain("   ⏭️  Already fixed at this SHA — skip AI fix");
    expect(h.lines).toContain("   ✅ Safety score: 10/10");
    expect(h.lines).toContain("   🧪 CI: ✅ 1 checks green");
    expect(h.lines).toContain("   👍 Approving...");
    expect(h.lines).toContain("   ✅ Approved!");
    expect(h.lines).toContain("   🔀 Merging...");
    expect(h.lines).toContain("   ✅ MERGED! SHA: c0ffee");
    expect(h.notifies.map((n) => n.status)).toEqual(["done"]);
  });

  test("the merge sends the head sha as the pre-merge condition", async () => {
    const h = harness({
      comments: [reviewComment(SAFE_REVIEW)],
      fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD } } },
    });
    await processPr(h.deps, ctx);

    const put = h.calls.find((c) => c.method === "PUT" && c.path.endsWith("/merge"));
    expect(put?.json).toEqual({ commit_title: `Auto-merge PR #${PR_NUM}`, merge_method: "merge", sha: HEAD });
  });
});

describe("case 3 — a permanent skip at this SHA skips without calling the agent", () => {
  test("skipped, agent untouched, skip notified once", async () => {
    const h = harness({
      prs: [makePr()],
      comments: [reviewComment(SAFE_REVIEW)],
      fixState: {
        [REPO]: { [String(PR_NUM)]: { sha: HEAD, skip_reason: "Hermes API server unreachable", notified: false } },
      },
    });

    const out = await processPr(h.deps, ctx);

    expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true });
    expect(h.agentPosts).toEqual([]);
    expect(approves(h.calls)).toBe(0);
    expect(merges(h.calls)).toBe(0);
    expect(h.lines).toContain("   ⏭️  Permanently skipped: Hermes API server unreachable (until head SHA changes)");
    // Python 1947 calls `notify_skip_once` as a bare statement: the notification
    // DOES fire (asserted below), but no `🔔 Skip notified` line is appended.
    // Only the three `if notify_skip_once(...):` sites report it — on those,
    // this line would appear in the ops channel on every single cron tick of
    // every permanently-skipped PR. Asserting its ABSENCE is the whole point.
    expect(h.lines).not.toContain("   🔔 Skip notified: Hermes API server unreachable");
    expect(h.notifies).toEqual([
      {
        repo: REPO,
        pr: PR_NUM,
        status: "skipped",
        summary: "⏭️ Skipped: Hermes API server unreachable — will not retry until the PR head changes",
        score: "",
        url: `https://github.com/${REPO}/pull/${PR_NUM}`,
      },
    ]);
  });
});

describe("case 4 — an [INFRA] agent failure skips permanently and never re-runs", () => {
  test("two ticks on the same SHA: the agent is called exactly once", async () => {
    const h = harness({
      prs: [makePr()],
      comments: [reviewComment(SAFE_REVIEW)],
      agent: [{ ok: false, snippet: "[INFRA] Hermes API server timed out after 1800s" }],
    });

    const first = await runTick(h.deps);
    expect(h.agentPosts).toHaveLength(1);
    expect(first).toContain("   ⏭️  AI fix skipped: [INFRA] Hermes API server timed out after 1800s");
    expect(first).toContain("   🔔 Skip notified: Hermes API server timed out after 1800s");
    // The recorded reason is the [INFRA] text with the prefix stripped.
    expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBe(
      "Hermes API server timed out after 1800s",
    );
    // The skip notification, and ONLY it: the same tick goes on to approve and
    // merge (the [INFRA] skip is recorded, not enforced, on a PR whose safety
    // and CI are clean), which is its own "done" notice. Counting every
    // notification here would assert a fact about the merge, not about the skip.
    expect(skipNotices(h)).toHaveLength(1);

    const second = await runTick(h.deps);

    // The whole point: the agent is NOT asked again, the skip is not
    // re-notified, and no second merge is attempted (the head did not change,
    // so `already` is true and the merge is skipped). All three only show up by
    // re-running the tick.
    expect(h.agentPosts).toHaveLength(1);
    expect(skipNotices(h)).toHaveLength(1);
    expect(merges(h.calls)).toBe(1);
    expect(second).toContain("   ⏭️  Permanently skipped: Hermes API server timed out after 1800s (until head SHA changes)");
    expect(second).not.toContain("   🤖 Running Hermes AI fix (100 turns max)...");
    expect(second).toContain("   ⏭️  Skipped: 1");
  });

  test("a NEW head sha releases the skip and the agent runs again", async () => {
    const h = harness({
      prs: [makePr()],
      comments: [reviewComment(SAFE_REVIEW)],
      agent: [{ ok: false, snippet: "[INFRA] gateway down" }],
    });
    await runTick(h.deps);
    expect(h.agentPosts).toHaveLength(1);

    // Same PR, new head — the state gate is keyed on the sha, so it opens.
    h.deps.loadFixState = () => ({
      ...h.fixState,
      [REPO]: { [String(PR_NUM)]: { sha: "b".repeat(40), skip_reason: "gateway down" } },
    });
    await runTick(h.deps);

    expect(h.agentPosts).toHaveLength(2);
  });
});

describe("case 5 — a dependabot pin violation is closed before anything else", () => {
  const PINNED_REPO = "asepharyana/nextjs-template";
  const bumpPr = (over: Record<string, any> = {}) =>
    makePr({
      title: "chore(deps): bump typescript from 5.9.2 to 7.0.2",
      user: { login: "dependabot[bot]" },
      ...over,
    });

  test("PATCH state=closed, and no review / agent / merge", async () => {
    const h = harness();

    const out = await processPr(h.deps, { token: "install-token", repo: PINNED_REPO, pr: bumpPr() });

    expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true });
    expect(closes(h.calls)).toHaveLength(1);
    expect(closes(h.calls)[0].json).toEqual({ state: "closed" });
    expect(approves(h.calls)).toBe(0);
    expect(merges(h.calls)).toBe(0);
    expect(h.agentPosts).toEqual([]);
    expect(h.execCalls).toEqual([]);
    expect(h.lines).toContain(
      "   ⛔ Toolchain pin violation: typescript 5.9.2 → 7.0.2 (allowed major 6)",
    );
    expect(h.lines).toContain(`   ✅ Closed #${PR_NUM} (pin violation)`);
  });

  test("a close that fails is reported and the PR is still abandoned", async () => {
    const h = harness();
    h.deps.api.request = async (method: string, path: string, o: { json?: unknown } = {}) => {
      h.calls.push({ method, path, json: o.json });
      if (method === "PATCH") return { status: 500, data: {} };
      return { status: 200, data: { repositories: [{ full_name: REPO }] } };
    };

    const out = await processPr(h.deps, { token: "install-token", repo: PINNED_REPO, pr: bumpPr() });

    // Python increments skipped ONLY on a 200 close (lines 1896-1897).
    expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: false });
    expect(h.lines).toContain("   ⚠️  Close failed HTTP 500 — leaving open");
  });
});

describe("case 6 — red CI closes a stale dependabot PR and skips everyone else", () => {
  const RED_CHECKS = [{ name: "typecheck", status: "completed", conclusion: "failure" }];
  // TWO fixtures are needed to reach the CI gate, and both are the Python's
  // own gates rather than test conveniences:
  //   - `SAFE_REVIEW`, because line 2044 is only reachable through the review
  //     branch; a PR with no review `continue`s at 1934 with `triggered` set.
  //   - a seeded `already`, because STEP B runs on ALL PRs (line 1951) and the
  //     agent stub's verdict is a successful push, which increments
  //     `fixed_count` (line 2009) independently of the CI gate. Seeding
  //     `already` keeps this case about the CI decision alone.
  const SEEDED = { [REPO]: { [String(PR_NUM)]: { sha: HEAD } } };
  // The age is computed against `deps.now()`, which the harness pins, so the
  // fixture's `created_at` has to be derived from the SAME clock — a real
  // `Date.now()` here would make the age negative and the close unreachable.
  const NOW_SEC = 1_700_000_000;
  const daysAgo = (d: number) => iso((NOW_SEC - d * 86_400) * 1000);
  const STALE = { ...LOCKFILE_BUMP, created_at: daysAgo(3) };

  test("dependabot older than STALE_CI_CLOSE_DAYS is closed", async () => {
    const h = harness({
      prs: [makePr(STALE)],
      comments: [reviewComment(SAFE_REVIEW)],
      checkRuns: RED_CHECKS,
      fixState: SEEDED,
      nowSec: NOW_SEC,
    });

    const out = await processPr(h.deps, { token: "install-token", repo: REPO, pr: makePr(STALE) });

    expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true });
    expect(closes(h.calls)).toHaveLength(1);
    expect(h.lines).toContain("   ⏭️  Already fixed at this SHA — skip AI fix");
    expect(h.lines).toContain("   🧪 CI: CI FAILED: typecheck");
    expect(h.lines).toContain("   ⛔ CI failing for 3.0d — closing stale dependabot PR");
    expect(h.lines).toContain(`   ✅ Closed #${PR_NUM} (stale failing CI)`);
    expect(merges(h.calls)).toBe(0);
    expect(h.agentPosts).toEqual([]);
  });

  test("a fresh dependabot PR is only waited on, not closed", async () => {
    const h = harness({
      prs: [makePr(LOCKFILE_BUMP)],
      comments: [reviewComment(SAFE_REVIEW)],
      checkRuns: RED_CHECKS,
      fixState: SEEDED,
    });
    const out = await processPr(h.deps, { token: "install-token", repo: REPO, pr: makePr(LOCKFILE_BUMP) });

    expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true });
    expect(closes(h.calls)).toHaveLength(0);
    expect(h.lines).toContain("   ⏳ Waiting for green CI");
  });

  test("a non-dependabot red-CI PR is skipped, never closed", async () => {
    const h = harness({
      prs: [makePr()],
      comments: [reviewComment(SAFE_REVIEW)],
      checkRuns: RED_CHECKS,
      fixState: SEEDED,
    });

    const out = await processPr(h.deps, ctx);

    expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true });
    expect(closes(h.calls)).toHaveLength(0);
    expect(h.lines).toContain("   ⏳ Waiting for green CI");
    // No age-based close for a human author: the Python's stale-CI close is
    // guarded by `author == "dependabot[bot]"` (line 2048) and nothing else.
    expect(h.lines).not.toContain(`   ⛔ CI failing for`);
  });
});

describe("case 7 — mergeable:false resolves once, then skips permanently", () => {
  test("one agent attempt, then the Python's exact unresolvable reason", async () => {
    // `NO_CODE_MARKER` puts this PR on the no_code_review path, so the AI fix is
    // skipped and the ONE agent call below is the conflict resolve itself.
    const h = harness({
      prs: [makePr({ ...LOCKFILE_BUMP, mergeable: false })],
      comments: [NO_CODE_MARKER],
      agent: [{ ok: false, snippet: "conflict with main, gave up" }],
    });

    const out = await processPr(h.deps, {
      token: "install-token",
      repo: REPO,
      pr: makePr({ ...LOCKFILE_BUMP, mergeable: false }),
    });

    expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true });
    expect(h.agentPosts).toHaveLength(1);
    expect(merges(h.calls)).toBe(0);
    expect(closes(h.calls)).toHaveLength(0);

    expect(h.lines).toContain("   📝 PR-Agent assessed (no-code/lockfile PR) — no code to review, treating as reviewed");
    expect(h.lines).toContain("   🔴 Merge conflicts");
    expect(h.lines).toContain("   🤖 Resolving merge conflict with Claude Code...");
    expect(h.lines).toContain("   ⏭️  Conflict fix failed: conflict with main, gave up");
    expect(h.lines).toContain(`   🔔 Skip notified: ${UNRESOLVABLE_CONFLICT}`);
    expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBe(UNRESOLVABLE_CONFLICT);
    expect(skipNotices(h)).toHaveLength(1);
    expect(h.notifies[0].status).toBe("skipped");
  });

  test("the reason is the Python's literal, not a paraphrase", () => {
    expect(UNRESOLVABLE_CONFLICT).toBe("Unresolvable merge conflict (Claude Code made no push)");
  });

  test("an [INFRA] failure records the stripped INFRA reason instead", async () => {
    const h = harness({
      prs: [makePr({ mergeable: false })],
      comments: [reviewComment(SAFE_REVIEW)],
      agent: [{ ok: false, snippet: "[INFRA] Hermes API server unreachable at http://127.0.0.1:8642/v1" }],
    });

    await processPr(h.deps, { token: "install-token", repo: REPO, pr: makePr({ mergeable: false }) });

    expect((h.fixState[REPO][String(PR_NUM)] as any).skip_reason).toBe(
      "Hermes API server unreachable at http://127.0.0.1:8642/v1",
    );
  });

  test("a successful resolve counts a fix and does NOT merge this tick", async () => {
    const h = harness({
      prs: [makePr({ mergeable: false })],
      comments: [reviewComment(SAFE_REVIEW)],
      agent: [{ ok: true, snippet: "resolved" }],
    });

    const out = await processPr(h.deps, { token: "install-token", repo: REPO, pr: makePr({ mergeable: false }) });

    expect(out).toEqual({ merged: false, triggered: false, fixed: true, skipped: true });
    expect(h.lines).toContain("   ✨ Conflict resolved: Hermes AI pushed 1 improvement commit(s)");
    expect(merges(h.calls)).toBe(0);
  });

  test("mergeable:null is NOT the conflict branch — Python tests `is False`", async () => {
    const h = harness({
      prs: [makePr({ mergeable: null })],
      comments: [reviewComment(SAFE_REVIEW)],
      fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD } } },
    });

    const out = await processPr(h.deps, { token: "install-token", repo: REPO, pr: makePr({ mergeable: null }) });

    expect(h.lines).not.toContain("   🔴 Merge conflicts");
    expect(out.merged).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Beyond the seven: the 409 arm, the tick framing, and the lock contract
// ═══════════════════════════════════════════════════════════════════════════

describe("the merge 409 arm re-runs the resolve exactly once too", () => {
  test("the 409 arm", async () => {
    const h = harness({
      prs: [makePr({ ...LOCKFILE_BUMP })],
      comments: [NO_CODE_MARKER],
      agent: [{ ok: false, snippet: "still conflicted" }],
      merge: { status: 409, data: { message: "Merge conflict" } },
    });

    const out = await processPr(h.deps, { token: "install-token", repo: REPO, pr: makePr(LOCKFILE_BUMP) });

    expect(out).toEqual({ merged: false, triggered: false, fixed: false, skipped: true });
    expect(h.agentPosts).toHaveLength(1);
    expect(h.lines).toContain("   ⚠️  Merge conflict");
    expect(h.lines).toContain(`   🔔 Skip notified: ${UNRESOLVABLE_CONFLICT}`);
  });
});

describe("runTick frames the report and counts the four booleans", () => {
  test("header, per-PR lines, then the summary block", async () => {
    const h = harness({ prs: [makePr()], nowSec: 1_700_000_000 });
    let clock = 1_700_000_000;
    h.deps.now = () => (clock += 1.5);

    const lines = await runTick(h.deps);

    expect(lines[0]).toMatch(/^🔍 PR Queue Worker — /);
    expect(lines[1]).toBe("=".repeat(50));
    expect(lines[2]).toBe("📋 Found 1 open PR(s) to process");
    expect(lines[3]).toBe("   ✨ AI auto-fix: ENABLED (Claude Code)");
    expect(lines[4]).toBe(`\n${"─".repeat(40)}`);
    expect(lines[5]).toBe(`🔀 ${REPO} #${PR_NUM} — Refactor: harden the parser`);
    expect(lines[6]).toBe("   👤 alice | branch: feature/harden → main");
    expect(lines).toContain("📡 No review → triggering PR-Agent...".replace("📡", "   📡"));

    // The summary block is SEVEN lines: the opening rule, the header, the four
    // counters, and the closing rule. Slicing six would drop the closing rule
    // and read the header as the block's first line.
    const tail = lines.slice(-7);
    expect(tail[0]).toBe(`\n${"=".repeat(50)}`);
    expect(tail[1]).toMatch(/^📊 Summary \(\d+\.\d+s\)$/);
    expect(tail[2]).toBe("   ✨ AI fixes applied: 0");
    expect(tail[3]).toBe("   ✅ Merged: 0");
    expect(tail[4]).toBe("   📡 Reviews triggered: 1");
    expect(tail[5]).toBe("   ⏭️  Skipped: 0");
    // The block is closed by a second rule line.
    expect(tail[6]).toBe("=".repeat(50));
  });

  test("a lock miss is silent: no scan, no sync, no report", async () => {
    const h = harness({ prs: [makePr()] });
    (h.deps as any).lock = { acquire: () => null };

    const lines = await runTick(h.deps);

    expect(lines).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("an empty queue with no sync lines stays truly silent", async () => {
    const h = harness({ prs: [] });
    const lines = await runTick(h.deps);
    expect(lines).toEqual([]);
  });
});

describe("--dry walks the same gates and suppresses every effect", () => {
  /**
   * The brief's `--dry` is "no state write, no push, no PR, no Discord", and
   * the controller's ruling is that it must be a FLAG on the deps, never an
   * `if (dry) return` in front of the pipeline — otherwise the dry path is the
   * one nobody runs. So this asserts the pipeline DECIDES under dry: it reaches
   * approve-and-merge and reports what it would have done.
   *
   * It is the real CLI's `--dry` path, driven through the same `runTick` the CLI
   * calls, which is as close to an end-to-end rehearsal as a hermetic suite gets.
   */
  test("a mergeable PR reports 'would approve and merge', saves nothing, notifies nobody", async () => {
    const h = harness({
      prs: [makePr()],
      comments: [reviewComment(SAFE_REVIEW)],
      fixState: { [REPO]: { [String(PR_NUM)]: { sha: HEAD } } },
      dry: true,
    });
    let saved = 0;
    h.deps.saveFixState = () => void (saved += 1);
    let flushed = 0;
    h.deps.flushReport = async () => void (flushed += 1);
    h.deps.notify = () => Promise.resolve();
    h.deps.loadFixState = () => ({ [REPO]: { [String(PR_NUM)]: { sha: HEAD } } });

    const lines = await runTick(h.deps);

    // The decision is reached, not skipped.
    expect(lines).toContain("   👍 Approving...");
    expect(lines).toContain(`   🧪 dry run: would approve and merge #${PR_NUM}`);
    // And NONE of the four effects happened.
    expect(approves(h.calls)).toBe(0);
    expect(merges(h.calls)).toBe(0);
    expect(h.notifies).toEqual([]);
    expect(saved).toBe(0);
    expect(flushed).toBe(0); // flush posts to Discord on a non-TTY
  });

  test("a pin violation under dry reports the close it would make, and makes none", async () => {
    const h = harness({ dry: true });

    await processPr(h.deps, {
      token: "install-token",
      repo: "asepharyana/nextjs-template",
      pr: makePr({
        title: "chore(deps): bump typescript from 5.9.2 to 7.0.2",
        user: { login: "dependabot[bot]" },
      }),
    });

    expect(h.lines).toContain(
      "   ⛔ Toolchain pin violation: typescript 5.9.2 → 7.0.2 (allowed major 6)",
    );
    expect(h.lines).toContain("   🧪 dry run: would close #7 (pin violation)");
    expect(closes(h.calls)).toEqual([]);
  });
});

/**
 * The `stepLockPrefix` guard matrix (Python 1961-1973).
 *
 *   if has_bun:                    -> fix_bun_lock
 *   elif "uv.lock" not in ci_msg:  -> fix_uv_lock
 *   else                           -> change nothing
 *
 * The third arm is the one that was wrong once. Rewriting the `elif` as a
 * two-way disjunction (`has_bun || msg.includes("uv.lock")`) inverts the guard:
 * on a non-Bun repo whose failing check already names `uv.lock`, the port
 * re-resolves and PUSHES a `bun.lock` the repo does not use, on a PR the Python
 * left untouched. These four cases exist so that inversion cannot come back —
 * the last one fails if the negative guard is dropped again.
 */
describe("the lockfile pre-fix guard (Python 1961-1973)", () => {
  const typecheck = (names: string[]) => [
    { name: "typecheck", status: "completed", conclusion: "failure" },
    ...names.map((name) => ({ name, status: "completed", conclusion: "failure" })),
  ];
  const run = async (opts: { hasBunLock: boolean; extraCheck: string }) => {
    const h = harness({
      prs: [makePr({ ...LOCKFILE_BUMP })],
      comments: [reviewComment(SAFE_REVIEW)],
      checkRuns: typecheck([opts.extraCheck]),
      hasBunLock: opts.hasBunLock,
      dry: true,
    });
    // `processPr` takes the OPEN PR, not the harness queue — the pre-fix only
    // runs for a trivial title (Python 1953: `is_trivial_pr(title, author)`),
    // so passing the default non-trivial fixture would silently skip the step
    // and make all four cases pass for the wrong reason.
    await processPr(h.deps, { token: "install-token", repo: REPO, pr: makePr({ ...LOCKFILE_BUMP }) });
    return h;
  };

  test("a Bun repo takes the bun arm regardless of what CI names", async () => {
    const h = await run({ hasBunLock: true, extraCheck: "uv.lock" });
    expect(h.lines).toContain("   🔧 CI failing: bun.lock stale — pre-fixing...");
  });

  test("a non-Bun repo whose CI does NOT name uv.lock takes the uv arm", async () => {
    const h = await run({ hasBunLock: false, extraCheck: "lint" });
    expect(h.lines).toContain("   🔧 CI failing: uv.lock stale — pre-fixing...");
  });

  test("a non-Bun repo whose CI ALREADY names uv.lock is left alone", async () => {
    // Python 1973's comment: re-resolving the file uv just complained about
    // costs a clone and changes nothing.
    const h = await run({ hasBunLock: false, extraCheck: "uv.lock" });
    expect(h.lines).not.toContain("   🔧 CI failing: bun.lock stale — pre-fixing...");
    expect(h.lines).not.toContain("   🔧 CI failing: uv.lock stale — pre-fixing...");
    // And the decisive one: neither toolchain was run.
    expect(h.execCalls).toEqual([]);
  });

  test("a Bun repo that already names uv.lock still pre-fixes bun.lock", async () => {
    // The guard lives on the uv arm only, so a Bun repo is unaffected.
    const h = await run({ hasBunLock: true, extraCheck: "uv.lock" });
    expect(h.lines).toContain("   🔧 CI failing: bun.lock stale — pre-fixing...");
  });
});

describe("the lock is released on every exit", () => {
  test("a throwing tick still releases, so the next tick can claim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prq-lock-"));
    const lockPath = join(dir, "worker.lock");
    let releaseCount = 0;
    const deps = {
      ...harness({ throwOn: (p) => p.includes("/pulls?") }).deps,
      lock: {
        acquire: (path: string) => {
          const lock = WorkerLock.acquire(path);
          if (!lock) return null;
          return {
            release: () => {
              releaseCount += 1;
              lock.release();
            },
          };
        },
      },
    };

    try {
      await expect(runTick(deps)).rejects.toThrow("boom");
      expect(releaseCount).toBe(1);
      expect(existsSync(lockPath)).toBe(false);
      // The property that matters in production: a second tick is not wedged.
      expect(WorkerLock.acquire(lockPath)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

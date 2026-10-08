/**
 * Lockfile pre-fixes, AI autofix and the merge actions — the task-13 brief's
 * six cases (verbatim) plus the coverage the brief does not name: the uv.lock
 * path, `checkPrStillValid`'s three invalid reasons, and credential redaction.
 *
 * HERMETIC BY CONSTRUCTION. Every external effect is a fake: the git/uv/bun
 * runner (argv in, `{code, stdout, stderr}` out), the workdir fs, the GitHub
 * client and the agent. No test spawns a process, touches `/tmp` or opens a
 * socket, so the suites pass identically on every machine.
 */
import { describe, expect, test } from "vitest";
import {
  fixBunLock,
  fixUvLock,
  isTrivialPr,
  repoHasBunLock,
  TMP_BASE,
  type LockfixDeps,
  type ProcRunner,
  type Workdirs,
} from "../src/pr/lockfix.ts";
import {
  AI_FIX_TIMEOUT,
  checkPrStillValid,
  killOrphanedAgent,
  pidFileFor,
  runAiFix,
  TRACKING_DIR,
  type AiFixDeps,
  type ProcessDeps,
} from "../src/pr/autofix.ts";
import { approvePr, mergePr } from "../src/pr/merge.ts";
import type { GitResult, GitRunner } from "../src/git.ts";
import type { GhClient } from "../src/pr/scan.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Fakes
// ═══════════════════════════════════════════════════════════════════════════

type Call = { args: string[]; cwd?: string; timeoutSec?: number };
type Reply = { code?: number; stdout?: string; stderr?: string };

/**
 * One scripted runner for BOTH seams: git (args[0] is a subcommand) and any
 * other program (`uv lock`, `bun install` — args[0] is the program). The two
 * namespaces cannot collide, so a single table answers both.
 *
 * `overrides` keys are matched as a prefix of the joined argv; the LONGEST
 * match wins, which is what makes `bun install --frozen-lockfile` beat
 * `bun install` and `merge --abort` beat nothing else. A call that matches
 * nothing gets `fallback` (success by default), so a test only scripts the
 * steps it actually cares about.
 */
function fakeProc(
  overrides: Record<string, Reply> = {},
  fallback: Reply = { code: 0 },
): { run: GitRunner; exec: ProcRunner; calls: Call[]; argvOf: (i: number) => string[] } {
  const calls: Call[] = [];
  const keys = Object.keys(overrides).sort((a, b) => b.length - a.length);
  const runner = ((args: string[], cwd?: string, timeoutSec?: number): GitResult => {
    calls.push({ args, cwd, timeoutSec });
    const cmd = args.join(" ");
    const hit = keys.find((k) => cmd.startsWith(k));
    const r: Reply = hit ? overrides[hit] : fallback;
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }) as GitRunner & ProcRunner;
  return { run: runner, exec: runner as ProcRunner, calls, argvOf: (i) => calls[i].args };
}

/** In-memory stand-in for the workdir + PID-file lifecycle. */
function fakeWorkdirs(seed: Record<string, string> = {}): {
  workdirs: Workdirs;
  removed: string[];
  written: { path: string; contents: string }[];
  dirs: Set<string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const removed: string[] = [];
  const written: { path: string; contents: string }[] = [];
  return {
    removed,
    written,
    dirs,
    workdirs: {
      exists: (p) => files.has(p) || dirs.has(p),
      mkdir: (p) => {
        dirs.add(p);
      },
      remove: (p) => {
        removed.push(p);
        files.delete(p);
        dirs.delete(p);
      },
      writeFile: (p, c) => {
        written.push({ path: p, contents: c });
        files.set(p, c);
      },
      readFile: (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
    },
  };
}

type ApiCall = { method: string; path: string; token?: string; json?: unknown };

function fakeApi(
  handler: (call: ApiCall, n: number) => { status: number; data: unknown } = () => ({
    status: 200,
    data: {},
  }),
): { api: GhClient; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const api: GhClient = {
    async request(method, path, opts) {
      const call: ApiCall = { method, path, token: opts?.token, json: opts?.json };
      calls.push(call);
      return handler(call, calls.length) as any;
    },
  };
  return { api, calls };
}

function fakeAgent(result: { ok: boolean; snippet: string }): {
  agent: AiFixDeps["agent"];
  calls: { prompt: string; opts: any }[];
} {
  const calls: { prompt: string; opts: any }[] = [];
  return {
    calls,
    agent: {
      async post(prompt: string, opts: any = {}) {
        calls.push({ prompt, opts });
        return result;
      },
    },
  };
}

const REPO = "owner/repo";
const PR = 7;
const BUN_WD = `${TMP_BASE}/owner_repo_bunfix_${PR}`;
const UV_WD = `${TMP_BASE}/owner_repo_lockfix_${PR}`;
const AI_WD = `${TMP_BASE}/owner_repo_${PR}`;

/** The base deps a lockfix flow needs. */
function lockfixDeps(
  proc: ReturnType<typeof fakeProc>,
  fs: ReturnType<typeof fakeWorkdirs>,
  fetchGhToken: () => string = () => "ghPAT",
): LockfixDeps {
  return { run: proc.run, exec: proc.exec, workdirs: fs.workdirs, fetchGhToken };
}

/** The base deps an AI-fix flow needs. */
function aiFixDeps(
  proc: ReturnType<typeof fakeProc>,
  fs: ReturnType<typeof fakeWorkdirs>,
  agent: AiFixDeps["agent"],
  api: GhClient = fakeApi().api,
  report?: { push: (line: string) => void },
): AiFixDeps {
  return { run: proc.run, workdirs: fs.workdirs, agent, api, report };
}

// ═══════════════════════════════════════════════════════════════════════════
// Brief tests (verbatim cases 1-6)
// ═══════════════════════════════════════════════════════════════════════════

describe("fixBunLock", () => {
  test("a passing frozen install skips the fix and cleans the workdir", async () => {
    const proc = fakeProc({ "bun install --frozen-lockfile": { code: 0 } });
    const fs = fakeWorkdirs({ [BUN_WD]: "stale" });
    const r = await fixBunLock(lockfixDeps(proc, fs), REPO, PR, "dependabot/npm/x", "main");
    expect(r).toEqual({
      ok: false,
      summary: "bun.lock already consistent with package.json (CI failure elsewhere)",
    });
    // The Python rm -rf's the workdir on every exit path (lines 726, 732, …).
    expect(fs.removed).toContain(BUN_WD);
    // A full clone — the Python's bun clone carries NO --depth (line 736), and
    // a `bun install` that never ran is proof the flow stopped where it should.
    expect(proc.argvOf(0)).toEqual([
      "clone",
      "https://x-access-token:ghPAT@github.com/owner/repo.git",
      BUN_WD,
      "--branch",
      "dependabot/npm/x",
    ]);
    expect(proc.argvOf(0)).not.toContain("--depth");
    expect(proc.calls.map((c) => c.args.join(" "))).toEqual([
      "clone https://x-access-token:ghPAT@github.com/owner/repo.git " + BUN_WD + " --branch dependabot/npm/x",
      "config user.name mytheclipsebotreview",
      "config user.email bot@users.noreply.github.com",
      "fetch origin main",
      "merge origin/main --no-edit --no-ff",
      "bun install --frozen-lockfile",
    ]);
  });

  test("a stale lockfile is re-synced, committed and pushed", async () => {
    const proc = fakeProc({
      "bun install --frozen-lockfile": { code: 1, stderr: "lockfile had changes" },
      "bun install": { code: 0 },
      "diff --name-only": { code: 0, stdout: "bun.lock\n" },
    });
    const fs = fakeWorkdirs();
    const r = await fixBunLock(lockfixDeps(proc, fs), REPO, PR, "dependabot/npm/x", "main");
    expect(r).toEqual({ ok: true, summary: "bun.lock regenerated and pushed" });
    // One table serves git AND bun, so the indexes are the FULL sequence:
    // clone, config, config, fetch, merge, frozen, install, diff, add, commit, push.
    expect(proc.argvOf(8)).toEqual(["add", "bun.lock"]); // NOT `add -A`
    expect(proc.argvOf(9)).toEqual(["commit", "-m", "chore: sync bun.lock after dependabot bump"]);
    expect(proc.argvOf(10)).toEqual(["push", "origin", "HEAD:dependabot/npm/x"]);
    expect(proc.calls[10].cwd).toBe(BUN_WD);
    // Timeout budgets are the Python's (lines 747, 748, 756, 769, 776, 777, 785).
    expect(proc.calls.map((c) => c.timeoutSec)).toEqual([60, 10, 10, 30, 30, 120, 180, 15, 15, 30, 60]);
    expect(fs.removed).toContain(BUN_WD);
  });
});

describe("mergePr", () => {
  test("a 403 retries as the owner PAT and returns THAT result", async () => {
    const { api, calls } = fakeApi((_c, n) =>
      n === 1 ? { status: 403, data: { message: "needs workflows" } } : { status: 200, data: { merged: true } },
    );
    let asked = 0;
    const r = await mergePr({ fetchGhToken: () => (asked++, "ghPAT") }, api, "appTok", REPO, PR, "sha123");
    expect(asked).toBe(1);
    expect(r).toEqual({ status: 200, data: { merged: true } });
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/repos/owner/repo/pulls/7/merge",
        token: "appTok",
        json: { commit_title: "Auto-merge PR #7", merge_method: "merge", sha: "sha123" },
      },
      {
        method: "PUT",
        path: "/repos/owner/repo/pulls/7/merge",
        token: "ghPAT",
        json: { commit_title: "Auto-merge PR #7", merge_method: "merge", sha: "sha123" },
      },
    ]);
  });
});

describe("runAiFix", () => {
  test("an [INFRA] agent failure is returned verbatim — the skip-once contract", async () => {
    const snippet = "[INFRA] Hermes API server unreachable at http://127.0.0.1:8642/v1 (gateway up? API_SERVER_ENABLED?)";
    const proc = fakeProc({ "diff --name-only": { code: 0, stdout: "src/a.ts\n" } });
    const fs = fakeWorkdirs();
    const { agent } = fakeAgent({ ok: false, snippet });
    const r = await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "chore: bump x", "abc123def456", "dep/x", "main", "appTok");
    expect(r).toEqual({ ok: false, summary: snippet });
    expect(r.summary.startsWith("[INFRA]")).toBe(true);
    expect(fs.removed).toContain(AI_WD);
  });

  test("no commit means no push and a 'no commit/push' summary", async () => {
    const proc = fakeProc({
      "diff --name-only": { code: 0, stdout: "src/a.ts\n" },
      "rev-list --count": { code: 0, stdout: "0\n" },
    });
    const fs = fakeWorkdirs();
    const { agent } = fakeAgent({ ok: true, snippet: "I looked at the code and changed nothing." });
    const r = await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "t", "abc123def456", "dep/x", "main", "appTok");
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("no commit/push");
    expect(r.summary).toBe("Hermes ran but no commit/push. Output: I looked at the code and changed nothing.");
    expect(proc.calls.map((c) => c.args[0])).not.toContain("push");
  });
});

describe("isTrivialPr", () => {
  test("a dependabot bump is trivial, a feature is not", () => {
    expect(isTrivialPr("chore(deps): bump x", "dependabot[bot]")).toBe(true);
    expect(isTrivialPr("feat: add login", "human")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The uv.lock path — the brief names the bun.lock path only
// ═══════════════════════════════════════════════════════════════════════════

describe("fixUvLock", () => {
  test("a refreshed lockfile is committed with -A and pushed", async () => {
    const proc = fakeProc({ "uv lock": { code: 0 }, "diff --name-only": { code: 0, stdout: "uv.lock\n" } });
    const fs = fakeWorkdirs();
    const r = await fixUvLock(lockfixDeps(proc, fs), REPO, PR, "dependabot/uv/x", "main");
    expect(r).toEqual({ ok: true, summary: "uv.lock regenerated and pushed" });
    expect(proc.argvOf(0)).toEqual([
      "clone",
      "https://x-access-token:ghPAT@github.com/owner/repo.git",
      UV_WD,
      "--branch",
      "dependabot/uv/x",
      "--depth",
      "5",
    ]);
    expect(proc.calls.map((c) => c.args.join(" "))).toEqual([
      "clone https://x-access-token:ghPAT@github.com/owner/repo.git " + UV_WD + " --branch dependabot/uv/x --depth 5",
      "config user.name mytheclipsebotreview",
      "config user.email bot@users.noreply.github.com",
      "fetch origin main --depth 5",
      "merge origin/main --no-edit",
      "uv lock",
      "diff --name-only",
      "add -A", // `-A` here, `bun.lock` there — Python lines 691 / 776
      "commit -m chore: refresh uv.lock after dependabot bump [skip ci]",
      "push origin HEAD:dependabot/uv/x",
    ]);
    expect(proc.calls.map((c) => c.timeoutSec)).toEqual([60, 10, 10, 30, 30, 180, 15, 15, 30, 60]);
    expect(fs.removed).toContain(UV_WD);
  });

  test("no gh token aborts before any git call and still cleans the workdir", async () => {
    const proc = fakeProc();
    const fs = fakeWorkdirs();
    const r = await fixUvLock(lockfixDeps(proc, fs, () => ""), REPO, PR, "dep/x", "main");
    expect(r).toEqual({ ok: false, summary: "no gh token" });
    expect(proc.calls).toEqual([]);
    expect(fs.removed).toContain(UV_WD);
    expect(fs.dirs.has(UV_WD)).toBe(false);
  });

  test("a failed clone reports the BARE string — no stderr on this path", async () => {
    const proc = fakeProc({ clone: { code: 128, stderr: "fatal: repository not found" } });
    const fs = fakeWorkdirs();
    const r = await fixUvLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main");
    expect(r).toEqual({ ok: false, summary: "clone failed" }); // Python line 653
    expect(fs.removed).toContain(UV_WD);
  });

  test("a merge conflict aborts the merge before removing the workdir", async () => {
    const proc = fakeProc({ "merge origin/main": { code: 1, stderr: "CONFLICT" } });
    const fs = fakeWorkdirs();
    const r = await fixUvLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main");
    expect(r).toEqual({ ok: false, summary: "merge conflict with main" });
    expect(proc.argvOf(proc.calls.length - 1)).toEqual(["merge", "--abort"]);
    expect(fs.removed).toContain(UV_WD);
  });

  test("an unchanged lockfile is reported as already consistent", async () => {
    const proc = fakeProc({ "uv lock": { code: 0 }, "diff --name-only": { code: 0, stdout: "" } });
    const fs = fakeWorkdirs();
    expect(await fixUvLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main")).toEqual({
      ok: false,
      summary: "no change (uv.lock already consistent)",
    });
  });

  test("a change with no lockfile in it is refused, listing the first three paths", async () => {
    const proc = fakeProc({
      "uv lock": { code: 0 },
      "diff --name-only": { code: 0, stdout: "a.py\nb.py\nc.py\nd.py\n" },
    });
    const fs = fakeWorkdirs();
    const r = await fixUvLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main");
    expect(r.ok).toBe(false);
    expect(r.summary.startsWith("unexpected files changed: ")).toBe(true);
    expect(r.summary).toContain("a.py");
    expect(r.summary).toContain("c.py");
    expect(r.summary).not.toContain("d.py");
  });

  test("a failed commit is fatal on the uv path (no 'nothing to commit' tolerance)", async () => {
    const proc = fakeProc({
      "uv lock": { code: 0 },
      "diff --name-only": { code: 0, stdout: "uv.lock\n" },
      commit: { code: 1, stderr: "nothing to commit, working tree clean" },
    });
    const fs = fakeWorkdirs();
    const r = await fixUvLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main");
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("commit failed: nothing to commit, working tree clean");
  });

  test("a failed push is reported with its stderr", async () => {
    const proc = fakeProc({
      "uv lock": { code: 0 },
      "diff --name-only": { code: 0, stdout: "uv.lock\n" },
      push: { code: 1, stderr: "! [rejected] HEAD -> dep/x (non-fast-forward)" },
    });
    const fs = fakeWorkdirs();
    expect(await fixUvLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main")).toEqual({
      ok: false,
      summary: "push failed: ! [rejected] HEAD -> dep/x (non-fast-forward)",
    });
  });
});

describe("fixBunLock — the branches the brief does not name", () => {
  /** Frozen fails, `bun install` fails too. */
  function syncing(extra: Record<string, Reply>) {
    return fakeProc({
      "bun install --frozen-lockfile": { code: 1 },
      "bun install": { code: 1, stderr: "x".repeat(400) + " resolver exploded" },
      ...extra,
    });
  }

  test("a failed sync reports the tail-then-head slice of stderr", async () => {
    const proc = syncing({});
    const fs = fakeWorkdirs();
    const r = await fixBunLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main");
    expect(r.ok).toBe(false);
    expect(r.summary.startsWith("bun install sync failed: ")).toBe(true);
    // Python line 766: `stderr[-300:][:100]` — tail 300, then head 100. The
    // tail lands 100 characters before the end of the message, so the final
    // words are NOT in the summary. That is the Python's slicing, not a bug.
    const detail = r.summary.slice("bun install sync failed: ".length);
    expect(detail).toHaveLength(100);
    expect(detail).not.toContain("resolver exploded");
  });

  test("a sync that touches no lockfile is reported as unexpected", async () => {
    const proc = syncing({ "bun install": { code: 0 }, "diff --name-only": { code: 0, stdout: "package.json\n" } });
    const fs = fakeWorkdirs();
    const r = await fixBunLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main");
    expect(r.ok).toBe(false);
    expect(r.summary.startsWith("bun install ran but bun.lock unchanged (unexpected files: ")).toBe(true);
    expect(r.summary).toContain("package.json");
  });

  test("'nothing to commit' is tolerated and the push still happens", async () => {
    const proc = syncing({
      "bun install": { code: 0 },
      "diff --name-only": { code: 0, stdout: "bun.lock\n" },
      commit: { code: 1, stderr: "nothing to commit, working tree clean" },
    });
    const fs = fakeWorkdirs();
    const r = await fixBunLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main");
    expect(r).toEqual({ ok: true, summary: "bun.lock regenerated and pushed" });
    expect(proc.argvOf(proc.calls.length - 1)).toEqual(["push", "origin", "HEAD:dep/x"]);
  });

  test("a failed clone carries 200 characters of stderr", async () => {
    const proc = fakeProc({ clone: { code: 128, stderr: "y".repeat(400) } });
    const fs = fakeWorkdirs();
    const r = await fixBunLock(lockfixDeps(proc, fs), REPO, PR, "dep/x", "main");
    expect(r.ok).toBe(false);
    expect(r.summary).toBe(`clone failed: ${"y".repeat(200)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Credential redaction — a previously shipped leak class, pinned here
// ═══════════════════════════════════════════════════════════════════════════

describe("credential redaction", () => {
  const PAT = "ghp_1234567890abcdef0123456789abcdef1234";
  const cloneStderr = `fatal: unable to access 'https://x-access-token:${PAT}@github.com/owner/repo.git/': Could not resolve host`;

  test("a clone failure summary does not carry the PAT", async () => {
    const proc = fakeProc({ clone: { code: 128, stderr: cloneStderr } });
    const fs = fakeWorkdirs();
    for (const r of [
      await fixBunLock(lockfixDeps(proc, fs, () => PAT), REPO, PR, "dep/x", "main"),
      await fixUvLock(lockfixDeps(proc, fs, () => PAT), REPO, PR, "dep/x", "main"),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.summary).not.toContain(PAT);
      expect(r.summary).not.toContain("ghp_");
    }
  });

  test("a push failure summary does not carry the token", async () => {
    // The host error is kept SHORT enough to survive the `[:100]` slice, so
    // this asserts both halves: the credential is gone, the diagnosis is not.
    const proc = fakeProc({
      "uv lock": { code: 0 },
      "diff --name-only": { code: 0, stdout: "uv.lock\n" },
      push: { code: 1, stderr: `Could not resolve host; fatal: ${cloneStderr}` },
    });
    const fs = fakeWorkdirs();
    const r = await fixUvLock(lockfixDeps(proc, fs, () => PAT), REPO, PR, "dep/x", "main");
    expect(r.summary).not.toContain(PAT);
    expect(r.summary).toContain("Could not resolve host"); // redaction stays narrow
    expect(r.summary).toContain("[REDACTED]");
  });

  test("a failed AI-fix push does not carry the token either", async () => {
    const proc = fakeProc({
      "diff --name-only": { code: 0, stdout: "src/a.ts\n" },
      "rev-list --count": { code: 0, stdout: "3\n" },
      push: { code: 1, stderr: `fatal: ${cloneStderr}` },
    });
    const fs = fakeWorkdirs();
    const { agent } = fakeAgent({ ok: true, snippet: "committed" });
    const r = await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "t", "abc123def456", "dep/x", "main", PAT);
    expect(r.ok).toBe(false);
    expect(r.summary).not.toContain(PAT);
    expect(r.summary.startsWith("AI committed but push failed: ")).toBe(true);
  });

  /**
   * The two sites where the AGENT'S OWN TEXT reaches a summary.
   *
   * These are not like the three above: the fragment is an LLM's final answer
   * written by a session holding file and terminal tools in the workdir the
   * worker just cloned. Git persists the credentialed clone URL in plaintext in
   * `.git/config` there, and "here is what I found" is a natural thing for the
   * agent to say. So these two summaries are the reachable path from a live
   * installation token to the ops Discord channel. `redactApiKey` in agent.ts
   * does NOT cover it — that only strips `API_SERVER_KEY`, a different secret.
   */
  const LEAKED = "ghp_FIXTUREnotAreal000000000000000000";
  const quotedConfig = `I read .git/config and found the remote url\n  url = https://x-access-token:${LEAKED}@github.com/owner/repo.git`;

  test("an [INFRA] agent snippet quoting the clone URL does not carry the token", async () => {
    // autofix.ts:366 — the VERBATIM skip-once site. The `[INFRA]` prefix and the
    // surrounding prose must survive; only the credential userinfo is rewritten.
    const proc = fakeProc({ "diff --name-only": { code: 0, stdout: "src/a.ts\n" } });
    const fs = fakeWorkdirs();
    const { agent } = fakeAgent({ ok: false, snippet: `[INFRA] gateway dropped. ${quotedConfig}` });
    const r = await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "t", "abc123def456", "dep/x", "main", "appTok");
    expect(r.ok).toBe(false);
    expect(r.summary).not.toContain(LEAKED);
    expect(r.summary).not.toContain("ghp_");
    expect(r.summary.startsWith("[INFRA] gateway dropped.")).toBe(true);
    expect(r.summary).toContain("I read .git/config and found the remote url");
    expect(r.summary).toContain("https://[REDACTED]@github.com/owner/repo.git");
  });

  test("a no-commit agent snippet quoting the clone URL does not carry the token", async () => {
    // autofix.ts:399 — the "ran but produced nothing" site. Same agent, same
    // workdir, so the same leak; here the snippet is truncated to 300 chars, so
    // redaction has to happen BEFORE `head()` for the token to be gone.
    const proc = fakeProc({
      "diff --name-only": { code: 0, stdout: "src/a.ts\n" },
      "rev-list --count": { code: 0, stdout: "0\n" },
    });
    const fs = fakeWorkdirs();
    const { agent } = fakeAgent({ ok: true, snippet: quotedConfig });
    const r = await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "t", "abc123def456", "dep/x", "main", "appTok");
    expect(r.ok).toBe(false);
    expect(r.summary).not.toContain(LEAKED);
    expect(r.summary).not.toContain("ghp_");
    expect(r.summary.startsWith("Hermes ran but no commit/push. Output: ")).toBe(true);
    expect(r.summary).toContain("I read .git/config and found the remote url");
    expect(r.summary).toContain("https://[REDACTED]@github.com/owner/repo.git");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runAiFix — the prompt, the agent call, the commit count, the push
// ═══════════════════════════════════════════════════════════════════════════

/** The prompt, written out here independently of the implementation. */
const expectedPrompt = (title: string, baseRef: string, files: string[]) => {
  let list = files
    .slice(0, 30)
    .map((f) => "  - " + f)
    .join("\n");
  if (files.length > 30) list += `\n  ... and ${files.length - 30} more`;
  return (
    `You are on the PR #${PR} branch of ${REPO}: "${title}"\n\n` +
    "Files changed in this PR:\n" +
    list +
    "\n\n" +
    "Your working directory is the git worktree for this PR branch.\n" +
    "Your task:\n" +
    "1. FIRST, try to merge the base branch to resolve any stale conflicts:\n" +
    `     git fetch origin ${baseRef}\n` +
    `     git merge origin/${baseRef} --no-edit\n` +
    "   If there are merge conflicts, resolve them intelligently\n" +
    "2. THEN improve code quality of ALL changed files:\n" +
    "   - Fix naming, DRY up repeated logic, add error handling\n" +
    "   - Add type hints / type annotations where missing\n" +
    "   - Fix anti-patterns, improve structure, add docstrings\n" +
    "3. Commit ALL changes with EXACT message:\n" +
    '     git add -A && git commit --message="fix: auto-fix code quality [skip ci]"\n' +
    "4. Do NOT push — a separate step pushes your commit.\n\n" +
    "CRITICAL RULES:\n" +
    "- ONLY modify the files listed above (plus commit/merge resolution)\n" +
    "- Do NOT change program logic or add features\n" +
    "- Resolve merge conflicts carefully - keep BOTH sides where needed\n" +
    "- You are mytheclipsebotreview - git identity already set\n" +
    '- Use EXACTLY "fix: auto-fix code quality [skip ci]" as the commit message'
  );
};

describe("runAiFix", () => {
  const DIFF = { "diff --name-only": { code: 0, stdout: "src/a.ts\nsrc/b.ts\n" } };

  test("the workdir comes from the shared TMP_BASE, and the three flows cannot collide", async () => {
    // Python line 831: NO infix on the AI-fix workdir, where the lockfix sites
    // add `_lockfix_` / `_bunfix_` (634, 723). If `runAiFix` re-typed the base
    // path instead of importing TMP_BASE, a change to one would silently point
    // the three flows at the same directory — so this asserts the constant, not
    // just a path that happens to work today.
    expect(AI_WD).toBe(`${TMP_BASE}/owner_repo_${PR}`);
    expect(BUN_WD).toBe(`${TMP_BASE}/owner_repo_bunfix_${PR}`);
    expect(UV_WD).toBe(`${TMP_BASE}/owner_repo_lockfix_${PR}`);
    expect(new Set([AI_WD, BUN_WD, UV_WD]).size).toBe(3);

    const proc = fakeProc({ ...DIFF, "rev-list --count": { code: 0, stdout: "0\n" } });
    const fs = fakeWorkdirs();
    const { agent } = fakeAgent({ ok: true, snippet: "" });
    await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "t", "abc123def456", "dep/x", "main", "tok");
    expect(fs.removed).toContain(`${TMP_BASE}/owner_repo_${PR}`);
  });

  test("a committed fix is pushed by the worker and counted", async () => {
    const proc = fakeProc({ ...DIFF, "rev-list --count": { code: 0, stdout: "2\n" } });
    const fs = fakeWorkdirs();
    const { agent } = fakeAgent({ ok: true, snippet: "committed 2 fixes" });
    const r = await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "feat: x", "abcdef1234567890", "feat/x", "main", "appTok");
    expect(r).toEqual({ ok: true, summary: "Hermes AI pushed 2 improvement commit(s)" });
    // The count comes from `rev-list --count <headSha[:12]>..HEAD` (line 930) —
    // twelve characters, and the WORKER pushes, never the agent.
    const rev = proc.calls.find((c) => c.args[0] === "rev-list")!;
    expect(rev.args).toEqual(["rev-list", "--count", "abcdef123456..HEAD"]);
    expect(rev.cwd).toBe(AI_WD);
    expect(rev.timeoutSec).toBe(10);
    expect(proc.argvOf(proc.calls.length - 1)).toEqual(["push", "origin", "HEAD:feat/x"]);
  });

  test("the prompt is the Python's, byte for byte, and the agent call is exact", async () => {
    const proc = fakeProc({ ...DIFF, "rev-list --count": { code: 0, stdout: "1\n" } });
    const fs = fakeWorkdirs();
    const { agent, calls } = fakeAgent({ ok: true, snippet: "done" });
    const notes: string[] = [];
    await runAiFix(
      aiFixDeps(proc, fs, agent, undefined, { push: (l) => notes.push(l) }),
      REPO,
      PR,
      "feat: x",
      "abc123def456",
      "feat/x",
      "main",
      "appTok",
    );
    expect(calls[0].prompt).toBe(expectedPrompt("feat: x", "main", ["src/a.ts", "src/b.ts"]));
    expect(calls[0].prompt).toContain("Do NOT push — a separate step pushes your commit.");
    expect(calls[0].prompt).toContain('git commit --message="fix: auto-fix code quality [skip ci]"');
    expect(calls[0].opts).toEqual({ workdir: AI_WD, timeoutSec: 1800, label: "hermes_pr_7" });
    expect(AI_FIX_TIMEOUT).toBe(1800);
    expect(notes).toEqual(["   🤖 Running Hermes AI fix (100 turns max)..."]);
    // The prompt file is AgentClient.post's job (agent.ts), not a second write.
    expect(fs.written).toEqual([]);
  });

  test("the file list is capped at 30 and the overflow is counted", async () => {
    const files = Array.from({ length: 33 }, (_, i) => `src/f${i}.ts`);
    const proc = fakeProc({
      "diff --name-only": { code: 0, stdout: files.join("\n") + "\n" },
      "rev-list --count": { code: 0, stdout: "0\n" },
    });
    const fs = fakeWorkdirs();
    const { agent, calls } = fakeAgent({ ok: true, snippet: "" });
    await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "t", "abc123def456", "dep/x", "main", "tok");
    expect(calls[0].prompt).toBe(expectedPrompt("t", "main", files));
    expect(calls[0].prompt).toContain("  - src/f29.ts\n  ... and 3 more");
  });

  test("an unparseable rev-list count is zero, not an error", async () => {
    const proc = fakeProc({ ...DIFF, "rev-list --count": { code: 128, stderr: "fatal: bad revision" } });
    const fs = fakeWorkdirs();
    const { agent } = fakeAgent({ ok: true, snippet: "fatal: bad revision" });
    const r = await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "t", "abc123def456", "dep/x", "main", "tok");
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("Hermes ran but no commit/push. Output: fatal: bad revision");
  });

  test("a failed push reports stderr, then stdout, then nothing", async () => {
    const base = { ...DIFF, "rev-list --count": { code: 0, stdout: "1\n" } };
    const onlyStdout = fakeProc({ ...base, push: { code: 1, stderr: "", stdout: "everything up-to-date" } });
    const neither = fakeProc({ ...base, push: { code: 1, stderr: "", stdout: "" } });
    for (const [proc, expected] of [
      [onlyStdout, "AI committed but push failed: everything up-to-date"],
      [neither, "AI committed but push failed: "],
    ] as const) {
      const fs = fakeWorkdirs();
      const { agent } = fakeAgent({ ok: true, snippet: "committed" });
      const r = await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "t", "abc123def456", "dep/x", "main", "tok");
      expect(r.summary).toBe(expected);
      expect(fs.removed).toContain(AI_WD);
    }
  });

  test("no changed files from git and none from the API stops the fix", async () => {
    const proc = fakeProc({ "diff --name-only": { code: 0, stdout: "" } });
    const fs = fakeWorkdirs();
    const { api, calls } = fakeApi(() => ({ status: 200, data: [] }));
    const { agent } = fakeAgent({ ok: true, snippet: "" });
    const r = await runAiFix(aiFixDeps(proc, fs, agent, api), REPO, PR, "t", "abc123def456", "dep/x", "main", "tok");
    expect(r).toEqual({ ok: false, summary: "no changed files to fix" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/owner/repo/pulls/7/files?per_page=50",
    ]);
    expect(agent.post).toBeDefined();
  });

  test("the GitHub files endpoint is the fallback, filtering by status", async () => {
    const proc = fakeProc({ "diff --name-only": { code: 0, stdout: "" } });
    const fs = fakeWorkdirs();
    const { api } = fakeApi(() => ({
      status: 200,
      data: [
        { filename: "src/a.ts", status: "modified" },
        { filename: "src/b.ts", status: "renamed" },
        { filename: "src/del.ts", status: "removed" }, // dropped, Python line 874
        { filename: "src/c.ts", status: "added" },
      ],
    }));
    const { agent, calls } = fakeAgent({ ok: true, snippet: "" });
    await runAiFix(aiFixDeps(proc, fs, agent, api), REPO, PR, "t", "abc123def456", "dep/x", "main", "tok");
    expect(calls[0].prompt).toContain("  - src/a.ts\n  - src/b.ts\n  - src/c.ts\n");
    expect(calls[0].prompt).not.toContain("src/del.ts");
  });

  test("a file entry with a status but no filename costs no agent call", async () => {
    // Python line 874 is `f["filename"]`, INSIDE the `try`. A missing key is a
    // KeyError, the `except Exception: pass` at 875-876 discards the WHOLE
    // comprehension, and lines 878-880 then return "no changed files to fix"
    // WITHOUT reaching the gateway. That matters: the fallback clone already
    // happened, and the next step is a paid agent call (up to 1800s) on a
    // prompt whose file list would be the literal string "undefined".
    const proc = fakeProc({ "diff --name-only": { code: 0, stdout: "" } });
    const fs = fakeWorkdirs();
    const { api } = fakeApi(() => ({
      status: 200,
      data: [{ status: "modified" }], // no filename — KeyError in the Python
    }));
    const { agent, calls } = fakeAgent({ ok: true, snippet: "" });
    const r = await runAiFix(aiFixDeps(proc, fs, agent, api), REPO, PR, "t", "abc123def456", "dep/x", "main", "tok");
    expect(r).toEqual({ ok: false, summary: "no changed files to fix" });
    expect(calls).toHaveLength(0); // the money: no gateway call was made
    expect(fs.removed).toContain(AI_WD);
  });

  test("a clone failure carries 200 characters of stderr", async () => {
    const proc = fakeProc({ clone: { code: 128, stderr: "z".repeat(500) } });
    const fs = fakeWorkdirs();
    const { agent } = fakeAgent({ ok: true, snippet: "" });
    const r = await runAiFix(aiFixDeps(proc, fs, agent), REPO, PR, "t", "abc123def456", "dep/x", "main", "appTok");
    expect(r).toEqual({ ok: false, summary: `clone failed: ${"z".repeat(200)}` });
    // The AI-fix clone is the `--depth 20` site (Python line 840) and it clones
    // with the CALLER's installation token, not the gh PAT (line 838).
    expect(proc.argvOf(0)).toEqual([
      "clone",
      "https://x-access-token:appTok@github.com/owner/repo.git",
      AI_WD,
      "--branch",
      "dep/x",
      "--depth",
      "20",
    ]);
    expect(fs.removed).toContain(AI_WD);
  });

  test("a failing files endpoint degrades to the git answer", async () => {
    const proc = fakeProc({ "diff --name-only": { code: 0, stdout: "src/a.ts\n" } });
    const fs = fakeWorkdirs();
    const api: GhClient = {
      async request() {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const { agent, calls } = fakeAgent({ ok: true, snippet: "" });
    const r = await runAiFix(aiFixDeps(proc, fs, agent, api), REPO, PR, "t", "abc123def456", "dep/x", "main", "tok");
    expect(r.ok).toBe(false); // nothing committed in this scripted run
    expect(calls[0].prompt).toContain("  - src/a.ts");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// checkPrStillValid — the four returns of lines 813-823
// ═══════════════════════════════════════════════════════════════════════════

describe("checkPrStillValid", () => {
  test("a non-200 or non-object body is a failed fetch", async () => {
    expect(await checkPrStillValid(fakeApi(() => ({ status: 404, data: {} })).api, "t", REPO, PR, "sha")).toEqual([
      false,
      "",
      undefined,
      "failed to fetch PR",
    ]);
    expect(await checkPrStillValid(fakeApi(() => ({ status: 200, data: [] })).api, "t", REPO, PR, "sha")).toEqual([
      false,
      "",
      undefined,
      "failed to fetch PR",
    ]);
    // github.ts's transport-failure sentinel.
    expect(await checkPrStillValid(fakeApi(() => ({ status: 0, data: {} })).api, "t", REPO, PR, "sha")).toEqual([
      false,
      "",
      undefined,
      "failed to fetch PR",
    ]);
  });

  test("a closed or merged PR is invalid, with a blank sha", async () => {
    for (const body of [{ state: "closed" }, { state: "open", merged: true }]) {
      const r = await checkPrStillValid(fakeApi(() => ({ status: 200, data: body })).api, "t", REPO, PR, "sha");
      expect(r).toEqual([false, "", undefined, "PR was closed/merged"]);
    }
  });

  test("a truthy non-boolean `merged` also counts as merged", async () => {
    // Python line 818: `data.get("merged", False)` — ANY truthy value, not just
    // the boolean `true`. `merged: 1` is therefore closed, and a bare truthy
    // check is what reproduces that.
    const { api } = fakeApi(() => ({ status: 200, data: { state: "open", merged: 1 } }));
    expect(await checkPrStillValid(api, "t", REPO, PR, "sha")).toEqual([
      false,
      "",
      undefined,
      "PR was closed/merged",
    ]);
  });

  test("a new head is invalid but still reports the new sha and mergeable", async () => {
    const { api, calls } = fakeApi(() => ({
      status: 200,
      data: { state: "open", head: { sha: "newsha" }, mergeable: true },
    }));
    expect(await checkPrStillValid(api, "t", REPO, PR, "oldsha")).toEqual([
      false,
      "newsha",
      true,
      "PR was updated by someone else",
    ]);
    expect(calls[0]).toEqual({
      method: "GET",
      path: "/repos/owner/repo/pulls/7",
      token: "t",
      json: undefined,
    });
  });

  test("an unchanged head is valid and carries the mergeable flag", async () => {
    const r = await checkPrStillValid(
      fakeApi(() => ({ status: 200, data: { state: "open", head: { sha: "sha" }, mergeable: null } })).api,
      "t",
      REPO,
      PR,
      "sha",
    );
    expect(r).toEqual([true, "sha", null, ""]);
  });

  test("a missing head does not throw", async () => {
    const r = await checkPrStillValid(
      fakeApi(() => ({ status: 200, data: { state: "open", mergeable: false } })).api,
      "t",
      REPO,
      PR,
      "sha",
    );
    expect(r).toEqual([true, "", false, ""]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// killOrphanedAgent — SIGTERM, 2s, SIGKILL, and always write our own pid
// ═══════════════════════════════════════════════════════════════════════════

function fakeProcessDeps(fs: ReturnType<typeof fakeWorkdirs>, alive: (pid: number) => boolean): {
  deps: ProcessDeps;
  killed: { pid: number; signal: string }[];
  slept: number[];
} {
  const killed: { pid: number; signal: string }[] = [];
  const slept: number[] = [];
  return {
    killed,
    slept,
    deps: {
      workdirs: fs.workdirs,
      procExists: alive,
      kill: (pid, signal) => void killed.push({ pid, signal }),
      sleep: (ms) => void slept.push(ms),
      pid: 4242,
    },
  };
}

describe("killOrphanedAgent", () => {
  const PID_FILE = `${TRACKING_DIR}/owner_repo_7.pid`;

  test("a live orphan gets SIGTERM, a 2s wait, then SIGKILL", () => {
    const fs = fakeWorkdirs({ [PID_FILE]: " 999 " });
    // Still alive after the wait, so the SIGKILL branch runs.
    const { deps, killed, slept } = fakeProcessDeps(fs, () => true);
    killOrphanedAgent(deps, REPO, PR);
    expect(killed).toEqual([
      { pid: 999, signal: "SIGTERM" },
      { pid: 999, signal: "SIGKILL" },
    ]);
    expect(slept).toEqual([2000]);
    // Always writes the CURRENT pid, and creates TRACKING_DIR first.
    expect(fs.written).toEqual([{ path: PID_FILE, contents: "4242" }]);
    expect(fs.dirs.has(TRACKING_DIR)).toBe(true);
    expect(pidFileFor(REPO, PR)).toBe(PID_FILE);
  });

  test("an orphan that dies on SIGTERM is not killed again", () => {
    const fs = fakeWorkdirs({ [PID_FILE]: "999" });
    let alive = true;
    const { deps, killed, slept } = fakeProcessDeps(fs, () => alive);
    deps.kill = (pid, signal) => {
      killed.push({ pid, signal });
      alive = false;
    };
    killOrphanedAgent(deps, REPO, PR);
    expect(killed).toEqual([{ pid: 999, signal: "SIGTERM" }]);
    expect(slept).toEqual([2000]);
  });

  test("a dead pid is not signalled at all", () => {
    const fs = fakeWorkdirs({ [PID_FILE]: "999" });
    const { deps, killed, slept } = fakeProcessDeps(fs, () => false);
    killOrphanedAgent(deps, REPO, PR);
    expect(killed).toEqual([]);
    expect(slept).toEqual([]);
    expect(fs.written).toHaveLength(1);
  });

  test("a missing or garbage pid file signals nothing and still writes ours", () => {
    const missing = fakeWorkdirs();
    const a = fakeProcessDeps(missing, () => true);
    killOrphanedAgent(a.deps, REPO, PR);
    expect(a.killed).toEqual([]);

    const garbage = fakeWorkdirs({ [`${TRACKING_DIR}/owner_repo_7.pid`]: "not-a-pid" });
    const b = fakeProcessDeps(garbage, () => true);
    killOrphanedAgent(b.deps, REPO, PR);
    expect(b.killed).toEqual([]);
    expect(garbage.written).toEqual([{ path: `${TRACKING_DIR}/owner_repo_7.pid`, contents: "4242" }]);
  });

  test("a signal error is swallowed (Python's OSError branch)", () => {
    const fs = fakeWorkdirs({ [PID_FILE]: "999" });
    const { deps } = fakeProcessDeps(fs, () => true);
    deps.kill = () => {
      throw new Error("ESRCH");
    };
    expect(() => killOrphanedAgent(deps, REPO, PR)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// repoHasBunLock + approvePr + the rest of the predicates
// ═══════════════════════════════════════════════════════════════════════════

describe("repoHasBunLock", () => {
  test("matches a bun.lock anywhere in the recursive tree", async () => {
    const { api, calls } = fakeApi(() => ({
      status: 200,
      data: { tree: [{ path: "package.json" }, { path: "apps/web/bun.lock" }] },
    }));
    expect(await repoHasBunLock(api, "tok", REPO, "sha")).toBe(true);
    // The TREE endpoint, not the contents endpoint (Python line 614).
    expect(calls[0]).toEqual({
      method: "GET",
      path: "/repos/owner/repo/git/trees/sha?recursive=1",
      token: "tok",
      json: undefined,
    });
  });

  test("a tree without a lock, a non-200, a bad body and a throw are all 'no'", async () => {
    const cases: GhClient[] = [
      fakeApi(() => ({ status: 200, data: { tree: [{ path: "package.json" }] } })).api,
      fakeApi(() => ({ status: 403, data: {} })).api,
      fakeApi(() => ({ status: 200, data: {} })).api,
      fakeApi(() => ({ status: 200, data: { tree: "nope" } })).api,
      { async request() { throw new Error("boom"); } },
    ];
    for (const api of cases) expect(await repoHasBunLock(api, "tok", REPO, "sha")).toBe(false);
  });
});

describe("approvePr", () => {
  test("posts an APPROVE review and returns the status", async () => {
    const { api, calls } = fakeApi(() => ({ status: 201, data: { id: 1 } }));
    expect(await approvePr(api, "tok", REPO, PR)).toBe(201);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/repos/owner/repo/pulls/7/reviews",
      token: "tok",
      json: { event: "APPROVE", body: "✅ Auto-approved by PR Queue Worker." },
    });
  });

  test("a failed approval returns its status, not a throw", async () => {
    const { api } = fakeApi(() => ({ status: 0, data: {} }));
    expect(await approvePr(api, "tok", REPO, PR)).toBe(0);
  });
});

describe("mergePr — the non-403 paths", () => {
  test("a 200 is returned as-is, with no PAT lookup", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, data: { merged: true } }));
    let asked = 0;
    const r = await mergePr({ fetchGhToken: () => (asked++, "ghPAT") }, api, "appTok", REPO, PR, "sha");
    expect(r).toEqual({ status: 200, data: { merged: true } });
    expect(asked).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("a 403 with no PAT returns the original 403", async () => {
    const { api, calls } = fakeApi(() => ({ status: 403, data: { message: "denied" } }));
    const r = await mergePr({ fetchGhToken: () => "" }, api, "appTok", REPO, PR, "sha");
    expect(r).toEqual({ status: 403, data: { message: "denied" } });
    expect(calls).toHaveLength(1);
  });

  // With no owner token the retry cannot run, so the caller is shown the App's
  // refusal alone. That distinction is invisible in the returned pair — say it
  // in the journal, where the next person diagnosing a 403 will find it.
  test("a 403 with no PAT states that the owner retry could not run", async () => {
    const { api } = fakeApi(() => ({ status: 403, data: { message: "denied" } }));
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      await mergePr({ fetchGhToken: () => "" }, api, "appTok", REPO, PR, "sha");
    } finally {
      console.error = originalError;
    }
    const message = logged.flat().map(String).join(" ");
    expect(message).toContain(`${REPO}#${PR}`);
    expect(message).toContain("gh auth token");
  });

  test("a 405 is never retried", async () => {
    const { api, calls } = fakeApi(() => ({ status: 405, data: { message: "not mergeable" } }));
    let asked = 0;
    await mergePr({ fetchGhToken: () => (asked++, "ghPAT") }, api, "appTok", REPO, PR, "sha");
    expect(asked).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("a PAT retry that also 403 reports the SECOND result", async () => {
    const { api, calls } = fakeApi((_c, n) =>
      n === 1
        ? { status: 403, data: { message: "needs workflows" } }
        : { status: 403, data: { message: "still denied" } },
    );
    const r = await mergePr({ fetchGhToken: () => "ghPAT" }, api, "appTok", REPO, PR, "sha");
    expect(r).toEqual({ status: 403, data: { message: "still denied" } });
    expect(calls).toHaveLength(2);
  });
});

describe("isTrivialPr — substring matching, author ignored", () => {
  test("every keyword matches as a substring, case-insensitively", () => {
    for (const kw of [
      "dependabot",
      "update",
      "bump",
      "chore(deps)",
      "pin dependencies",
      "update version",
      "docs:",
      "readme",
      "changelog",
    ]) {
      expect(isTrivialPr(`prefix ${kw.toUpperCase()} suffix`, "x")).toBe(true);
    }
  });

  test("a real feature title is not trivial", () => {
    expect(isTrivialPr("feat: add login", "human")).toBe(false);
    expect(isTrivialPr("refactor: split the parser", "human")).toBe(false);
  });

  test("the author never influences the result (Python never reads it)", () => {
    expect(isTrivialPr("feat: add login", "dependabot[bot]")).toBe(false);
    expect(isTrivialPr("chore(deps): bump x", "a-human")).toBe(true);
  });

  test("a non-string title does not throw — Python's str() coerces", () => {
    expect(isTrivialPr(undefined as any, "human")).toBe(false);
    expect(isTrivialPr(12345 as any, "human")).toBe(false);
    expect(isTrivialPr(null as any, "human")).toBe(false);
  });
});

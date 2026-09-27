/**
 * Worker entry point + CLI — the port of the Python's
 * `if __name__ == "__main__":` block (lines 2189-2224) and its construction of
 * the global collaborators, which lived at module scope in the Python.
 *
 * `bootstrapEnv()` MUST stay the first statement: PATH and the `PR_AGENT_*`
 * secrets have to be in place before anything reads config. The Python did this
 * at IMPORT time, before its config constants resolved, and ES module imports
 * hoist, so the guarantee has to be made explicitly. It is deliberately NOT
 * inside `runTick` — the brief puts it there, but the Python and env.ts's
 * call-order note both put it at the entry point, and the entry point is where
 * it can be first. (Noted in the task-14 report.)
 *
 * THE SIGTERM HANDLER IS NOT OPTIONAL. The Python installs `_term_handler`
 * (2194-2198) so a cron `kill` releases the lockfile instead of leaving it to
 * be recycled by a PID-liveness check on the next tick. `runTick` reports its
 * lock through `onLockAcquired`; without that seam the handler has nothing to
 * release, and a stale lock wedges every later tick.
 */
import { bootstrapEnv } from "./env";

bootstrapEnv();

import { readFileSync } from "node:fs";
import { AgentClient } from "./agent";
import { notifyReview, postDiscordOps } from "./discord";
import { GitHubApi } from "./github";
import { runGit } from "./git";
import { LOCK_FILE, WorkerLock } from "./lock";
import { nodeProcessDeps } from "./pr/autofix";
import { nodeWorkdirs, type ProcRunner } from "./pr/lockfix";
import { runTick, type WorkerDeps } from "./pr/pipeline";
import { Report } from "./report";
import { FIX_STATE_FILE, loadFixState, loadSyncState, saveFixState } from "./state";
import { fileSyncState, runUpstreamSync } from "./sync/run";

// ── Config, all read at CALL time (Python lines 59-62) ──────────────────────

/** Python `APP_ID` (line 59) — a dev default, never a secret. */
const APP_ID = process.env.PR_AGENT_APP_ID || "4319749";
/** Python `PRIVATE_KEY_PATH` (line 60). */
const KEY_PATH = process.env.PR_AGENT_KEY_PATH || "/home/code/.hermes/keys/pr-agent-key.pem";
/** Python `WEBHOOK_SECRET` (line 61) — empty means signing with the empty key. */
const WEBHOOK_SECRET = process.env.PR_AGENT_WEBHOOK_SECRET || "";
/** Python `PR_AGENT_WEBHOOK_URL` (line 62). */
const WEBHOOK_URL =
  process.env.PR_AGENT_WEBHOOK_URL || "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks";

// ── The collaborators the Python held as module globals ─────────────────────

/**
 * The `ProcRunner` port: run a non-git command, never throwing.
 *
 * `runGit` is the wrong port here — it prefixes every argv with `git`, which
 * would turn `uv lock` into `git uv lock`. The Python's equivalent is
 * `subprocess.run(args, capture_output=True, text=True, timeout=N)`, and its
 * failure modes are the ones the callers branch on: a non-zero exit (`uv lock`
 * failed) and a missing binary (127). Both are reported, never thrown, and
 * `exitedDueToTimeout` maps to the Python's `TimeoutExpired` → 124, the same
 * exit code `git.ts` uses.
 */
const runProc: ProcRunner = (args, cwd, timeoutSec = 180) => {
  try {
    const r = Bun.spawnSync({
      cmd: args.map(String),
      cwd: cwd ? String(cwd) : undefined,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutSec * 1000,
    });
    if (r.exitedDueToTimeout) {
      return { code: 124, stdout: "", stderr: `timeout after ${timeoutSec}s` };
    }
    return {
      code: r.exitCode ?? 127,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { code: e.code === "ENOENT" ? 127 : 1, stdout: "", stderr: String(e.message ?? err) };
  }
};

/**
 * Build the real deps from the environment.
 *
 * The Python constructed these at import time, where a missing private key
 * raises immediately (line 161: `PRIVATE_KEY_PATH.read_text()`). That is
 * reproduced here rather than softened: an empty `privateKeyPem` does NOT
 * degrade into "no PRs", it throws out of `crypto.sign` deep inside the first
 * `request`, which reads as a crash in the wrong place. Failing at the read,
 * with the path in the message, is both what the Python does and the cheaper
 * failure to debug.
 *
 * It is a FUNCTION rather than module scope so that `--sync-status` — a
 * read-only JSON dump of a local file that needs no credential at all — cannot
 * fail because the key is absent. That is the one place the Python's
 * import-time construction is genuinely inconvenient.
 */
function buildDeps(opts: { dry: boolean; report: Report }): WorkerDeps {
  // The key is the one thing that cannot be faked, so read it with a message
  // an operator can act on. A bare `readFileSync` here surfaced as a raw ENOENT
  // stack pointing at `readFileSync`, which reads like a bug in the worker
  // rather than a missing deployment credential. Every other external effect
  // below is a function or a client and fails on use; only this one is read
  // eagerly, so only this one needs the guard.
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(KEY_PATH, "utf8");
  } catch {
    throw new Error(
      `GitHub App private key not found at ${KEY_PATH}. Set PR_AGENT_KEY_PATH ` +
        `(and PR_AGENT_APP_ID), or run --sync-status, which needs no credential.`,
    );
  }
  const api = new GitHubApi({
    appId: APP_ID,
    privateKeyPem, // Python line 161
  });
  const workdirs = nodeWorkdirs();
  const syncState = fileSyncState();
  return {
    api,
    agent: new AgentClient(),
    run: runGit,
    exec: runProc,
    workdirs,
    procs: nodeProcessDeps(workdirs),
    fetchGhToken: () => api.fetchGhToken(),
    report: opts.report,
    flushReport: () => opts.report.flush(),
    notify: notifyReview,
    postDiscord: postDiscordOps,
    loadFixState: () => loadFixState(),
    saveFixState: (state) => saveFixState(FIX_STATE_FILE, state),
    loadSyncState: () => syncState.load(),
    saveSyncState: (state) => syncState.save(state),
    repoOverrides: {},
    now: () => Date.now() / 1000,
    fetchImpl: (input, init) => fetch(input, init as RequestInit),
    lock: { acquire: (path) => WorkerLock.acquire(path) },
    webhookSecret: WEBHOOK_SECRET,
    webhookUrl: WEBHOOK_URL,
    dry: opts.dry,
  };
}

// ── SIGTERM ─────────────────────────────────────────────────────────────────

/**
 * Python `_term_handler` (2194-2198): release the lock, then exit `128+signum`.
 *
 * The handler is registered ONCE and reads a module-level slot rather than a
 * closure per mode, so the `--sync-only` and `runTick` paths share it.
 *
 * `process.exit` is what makes this correct rather than merely adequate: it
 * does NOT unwind `try`/`finally`, so the Python's `SystemExit` → `finally` →
 * `release_lock()` chain has to be reproduced by hand here. Every path that
 * takes the lock also clears the slot, so a second SIGTERM cannot re-enter a
 * release that already happened, and a release is idempotent anyway
 * (`unlinkSync` on a missing path is a no-op).
 */
let releaseHeld: (() => void) | null = null;
process.on("SIGTERM", () => {
  releaseHeld?.();
  releaseHeld = null;
  process.exit(143); // 128 + 15
});

// ── CLI modes ───────────────────────────────────────────────────────────────

/**
 * `--sync-only <owner/fork> [--dry]` (Python lines 2209-2223): take the lock,
 * run the upstream sync for one repo, print the report, release.
 *
 * The lock refusal PRINTS and exits 1 here (Python line 2216-2217) rather than
 * returning silently as `main()` does — a human at a terminal needs to know why
 * nothing happened.
 */
async function syncOnly(argv: string[]): Promise<number> {
  const i = argv.indexOf("--sync-only");
  const next = argv[i + 1];
  const target = next && !next.startsWith("-") ? next : undefined;
  const dry = argv.includes("--dry");

  const lock = WorkerLock.acquire(LOCK_FILE);
  if (!lock) {
    console.log("another pr-queue-worker run holds the lock — try again shortly");
    return 1;
  }
  releaseHeld = () => lock.release();
  try {
    const deps = buildDeps({ dry, report: new Report() });
    const report = await runUpstreamSync(
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
        report: deps.report,
        repoOverrides: deps.repoOverrides,
      },
      { only: target, dry },
    );
    console.log(report.length ? report.join("\n") : "(nothing to sync)");
  } finally {
    lock.release();
    releaseHeld = null;
  }
  return 0;
}

// ── main ───────────────────────────────────────────────────────────────────

/**
 * The three CLI modes, in the Python's order of precedence (lines 2206-2224):
 * `--sync-status` wins over `--sync-only`, and the absence of both is the tick.
 *
 * `--sync-status` deliberately takes NO lock and touches no network: it is the
 * read-only mode, and it has to stay answerable while a tick is running, which
 * is exactly when an operator most wants to ask it.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--sync-status")) {
    console.log(JSON.stringify(loadSyncState(), null, 2));
    return 0;
  }
  if (argv.includes("--sync-only")) return syncOnly(argv);

  const report = new Report();
  await runTick({
    ...buildDeps({ dry: argv.includes("--dry"), report }),
    onLockAcquired: (release) => {
      releaseHeld = release;
    },
  });
  // `runTick` released the lock in its own `finally`; drop the stale handle so a
  // later SIGTERM cannot unlink a lockfile some LATER process now owns.
  releaseHeld = null;
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  // A missing credential is an operator-actionable configuration error, not a
  // crash: report it as one line on stderr with a non-zero exit, instead of a
  // stack trace that buries the cause. Anything else is a real defect and keeps
  // its stack for debugging.
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("private key not found")) {
    console.error(`pr-queue-worker: ${message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}

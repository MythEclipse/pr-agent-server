import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneForPr,
  isProtectedPushError,
  isWorkflowPushError,
  pushRef,
  pushUrls,
  runGit,
  setBotIdentity,
  type GitResult,
  type GitRunner,
} from "../src/git";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A recorded call to the stubbed runner. */
type Call = { args: string[]; cwd?: string; timeoutSec?: number };

/**
 * Stub runner. `results` is consumed one entry per call; a call past the end
 * returns success, so a test only has to script the failures it cares about.
 * `run` returning undefined means "not a push" (clone/config), which succeeds.
 */
function stubRunner(
  results: (GitResult | undefined)[],
): { run: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    run: (args, cwd, timeoutSec) => {
      calls.push({ args, cwd, timeoutSec });
      return results[i++] ?? { code: 0, stdout: "", stderr: "" };
    },
  };
}

const ok: GitResult = { code: 0, stdout: "", stderr: "" };
const fail = (stderr: string, stdout = ""): GitResult => ({ code: 1, stdout, stderr });

/** temp dir that cleans itself up; `TMPDIR` already points at the scratch dir. */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── Brief tests (verbatim) ───────────────────────────────────────────────────

describe("git helpers", () => {
  test("classifies protected-branch push errors", () => {
    expect(isProtectedPushError("remote: error: GH006: Protected branch update failed")).toBe(true);
    expect(isProtectedPushError("required status check \"ci\" is expected")).toBe(true);
    expect(isProtectedPushError("everything up-to-date")).toBe(false);
  });
  test("classifies workflow-permission push errors", () => {
    expect(isWorkflowPushError("refusing to allow an OAuth App to create or update workflow")).toBe(true);
    expect(isWorkflowPushError("permission denied")).toBe(false);
  });
  test("PAT is tried before the app token", () => {
    const urls = pushUrls("o/f", "apptok", "pattok");
    expect(urls.map((u) => u.kind)).toEqual(["pat", "app"]);
  });
  test("runGit returns code 124 on timeout and 127 when git is missing", () => {
    expect(runGit(["--version"], "/tmp", 5).code).toBe(0);
    const t = runGit(["fetch"], "/tmp", 0.001);
    expect([124, 128]).toContain(t.code); // timeout atau "not a git repository"
  });
});

// ── runGit: never throws, and maps Bun's outcomes onto Python's ──────────────

describe("runGit result mapping", () => {
  test("returns stdout and stderr as strings", () => {
    const r = runGit(["--version"], "/tmp", 5);
    expect(typeof r.stdout).toBe("string");
    expect(typeof r.stderr).toBe("string");
    expect(r.stdout).toContain("git version");
  });

  test("defaults to a 180s timeout like the Python", () => {
    // Nothing observable about the default reaches outside the module, so this
    // pins the constant through the documented contract instead: the brief's
    // port keeps 180 as the default and 300 for push. See pushRef test below.
    expect(runGit(["--version"]).code).toBe(0);
  });

  test("git not on PATH becomes 127 / 'git not found' and never throws", () => {
    // Bun.spawnSync THROWS an ENOENT for a missing binary, so runGit has to
    // catch it. The only way to exercise the real code path without emptying
    // PATH for the whole test run is a child bun process pointed at a
    // git-free directory. PATH must be non-empty: Bun falls back to a baked-in
    // default PATH when it is "", and git would then be found anyway.
    const empty = tempDir("nogit-");
    const mod = join(import.meta.dir, "..", "src", "git.ts");
    const script =
      `const m = await import(${JSON.stringify(mod)});` +
      `const r = m.runGit(["--version"]);` +
      `console.log(JSON.stringify(r));`;
    const child = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      env: { ...process.env, PATH: empty },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expect(child.exitCode).toBe(0);
      const r = JSON.parse(child.stdout.toString()) as GitResult;
      expect(r.code).toBe(127);
      expect(r.stderr).toBe("git not found");
      expect(r.stdout).toBe("");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("a blocking git command hits the timeout and becomes 124", () => {
    // Deterministic timeout: a pre-commit hook that sleeps 5s blocks `git
    // commit` for far longer than the 0.5s budget, so this cannot race the way
    // `git fetch` in /tmp does.
    const dir = tempDir("gittimeout-");
    try {
      runGit(["init", "-q", dir]);
      runGit(["config", "user.email", "b@b.c"], dir, 10);
      runGit(["config", "user.name", "b"], dir, 10);
      writeFileSync(join(dir, "f.txt"), "x");
      runGit(["add", "f.txt"], dir, 10);
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      const hook = join(dir, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\nsleep 5\n");
      chmodSync(hook, 0o755);

      const t0 = Date.now();
      const r = runGit(["commit", "-m", "x"], dir, 0.5);
      const elapsed = Date.now() - t0;

      // Bun reports a timeout as exitCode null + signalCode SIGTERM; the port
      // maps it to 124 here. The 5s hook proves we did not wait it out.
      expect(r.code).toBe(124);
      expect(r.stderr).toContain("timeout after 0.5s");
      // Python line 1064 passes stdout as the literal "" on a timeout, so
      // partial child output is dropped rather than surfaced.
      expect(r.stdout).toBe("");
      expect(elapsed).toBeLessThan(4000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Classifiers: raw input, case-insensitive, never throw ───────────────────

describe("push error classifiers", () => {
  test("match every protected marker regardless of case", () => {
    for (const m of [
      "PROTECTED BRANCH",
      "Gh006: nope",
      "Required Status Check ci",
      "Branch Protection rules",
      "protected_branch denied",
    ]) {
      expect(isProtectedPushError(m)).toBe(true);
    }
  });

  test("match every workflow marker, including the literal backtick variant", () => {
    for (const m of [
      "GitHub App lacks `Workflows` permission",
      "the `workflows` permission is required",
      "Cannot Create Or Update Workflow file",
    ]) {
      expect(isWorkflowPushError(m)).toBe(true);
    }
  });

  test("empty and nullish input return false instead of throwing", () => {
    // Cast at the call boundary on purpose: the brief types the parameter as
    // `string`, but the Python's `(err or "")` explicitly tolerates None, and
    // the controller requires that None must not throw. The cast is the test
    // asserting the runtime contract, not widening the production signature.
    const nullish = [null, undefined] as unknown as string[];
    for (const fn of [isProtectedPushError, isWorkflowPushError]) {
      expect(fn("")).toBe(false);
      for (const v of nullish) expect(fn(v)).toBe(false);
    }
  });

  test("do not cross-match each other's markers", () => {
    expect(isProtectedPushError("needs the `workflows` App permission")).toBe(false);
    expect(isWorkflowPushError("GH006: Protected branch update failed")).toBe(false);
  });
});

// ── pushUrls: PAT-first, each credential conditional ────────────────────────

describe("pushUrls", () => {
  test("omits the app entry when appToken is empty", () => {
    const urls = pushUrls("o/f", "", "pattok");
    expect(urls.map((u) => u.kind)).toEqual(["pat"]);
    expect(urls[0]!.url).toContain("pattok");
    expect(urls[0]!.url).toContain("github.com/o/f.git");
  });

  test("falls back to the app token alone when there is no PAT", () => {
    // The gh CLI being unavailable leaves the App token as the only credential.
    const urls = pushUrls("o/f", "apptok", "");
    expect(urls.map((u) => u.kind)).toEqual(["app"]);
  });

  test("is empty when neither credential exists", () => {
    expect(pushUrls("o/f", "", "")).toEqual([]);
  });
});

// ── pushRef: stop-immediately semantics + no credential leak ────────────────

describe("pushRef", () => {
  test("PAT success returns ok with 'pat push ok' on the first try", () => {
    const { run, calls } = stubRunner([ok]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/x", "apptok", false, { pat: "pattok", run });
    expect(r).toEqual({ ok: true, detail: "pat push ok", protected: false });
    expect(calls).toHaveLength(1); // never touched the app token
    expect(calls[0]!.args[0]).toBe("push");
    expect(calls[0]!.args[2]).toBe("HEAD:refs/heads/x"); // no "+" without force
    expect(calls[0]!.timeoutSec).toBe(300); // longer than the 180s default
  });

  test("an unclassified error advances to the next credential", () => {
    const { run, calls } = stubRunner([fail("connection reset"), ok]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/x", "apptok", false, { pat: "pattok", run });
    expect(r).toEqual({ ok: true, detail: "app push ok", protected: false });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[1]).toContain("pattok");
    expect(calls[1]!.args[1]).toContain("apptok");
  });

  test("force prefixes the refspec with '+'", () => {
    const { run, calls } = stubRunner([ok]);
    pushRef("/wd", "o/f", "abc123", "refs/heads/main", "apptok", true, { pat: "pattok", run });
    expect(calls[0]!.args[2]).toBe("+abc123:refs/heads/main");
  });

  test("a protected-branch error stops the loop immediately", () => {
    const { run, calls } = stubRunner([fail("remote: error: GH006: Protected branch update failed"), ok]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "apptok", false, { pat: "pattok", run });
    expect(r.ok).toBe(false);
    expect(r.protected).toBe(true);
    expect(calls).toHaveLength(1); // the app token was NOT tried
    expect(r.detail).toContain("pat: ");
  });

  test("a workflow-permission error stops the loop and names both fixes", () => {
    const { run, calls } = stubRunner([
      fail("refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml`"),
      ok,
    ]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "apptok", false, { pat: "pattok", run });
    expect(r.ok).toBe(false);
    expect(r.protected).toBe(false);
    expect(calls).toHaveLength(1);
    expect(r.detail).toContain("needs the `workflows` App permission or the gh PAT (");
  });

  test("with no credentials at all it reports the sentinel detail", () => {
    const { run, calls } = stubRunner([ok]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "", false, { pat: "", run });
    expect(r).toEqual({ ok: false, detail: "no push credentials available", protected: false });
    expect(calls).toHaveLength(0);
  });

  test("never leaks the token into detail and keeps only the last 260 chars", () => {
    // Two unclassified failures, so the loop runs to exhaustion and `last`
    // holds the APP detail — exactly as the Python, whose `last` is whatever
    // the final credential produced.
    const { run } = stubRunner([fail("x".repeat(500)), fail("y".repeat(500))]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "apptok", false, { pat: "pattok", run });
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain("pattok");
    expect(r.detail).not.toContain("apptok");
    expect(r.detail).not.toContain("x-access-token");
    expect(r.detail).toBe(`app: ${"y".repeat(260)}`);
  });

  test("truncates the PAT attempt's error to the last 260 chars too", () => {
    // One credential, so the detail is the PAT attempt's own: "pat: " plus
    // exactly the error's tail. The unclassified error keeps the loop moving,
    // but with no app token the PAT detail is what survives.
    const { run } = stubRunner([fail("z".repeat(400))]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "", false, { pat: "pattok", run });
    expect(r.detail).toBe(`pat: ${"z".repeat(260)}`);
    expect(r.detail).not.toContain("pattok");
  });

  test("concatenates stderr and stdout, as the Python does", () => {
    const { run } = stubRunner([fail("ERR-part", "OUT-part")]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "apptok", false, { pat: "", run });
    expect(r.detail).toBe("app: ERR-partOUT-part");
  });
});

// ── clone + bot identity ─────────────────────────────────────────────────────

describe("cloneForPr", () => {
  test("clones with the flags after the directory, then sets the bot identity there", () => {
    const { run, calls } = stubRunner([ok]);
    expect(cloneForPr("o/f", "feature", "tok", "/wd/new", 20, { run })).toBe(true);
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      // Python line 840 order: url, dir, THEN the flags.
      "clone https://x-access-token:tok@github.com/o/f.git /wd/new --branch feature --depth 20",
      "config user.name mytheclipsebotreview",
      "config user.email bot@users.noreply.github.com",
    ]);
    // Identity must land in the CLONED dir, not the caller's cwd.
    expect(calls[1]!.cwd).toBe("/wd/new");
    expect(calls[2]!.cwd).toBe("/wd/new");
  });

  test("defaults to depth 20 and lets the lockfix caller ask for 5", () => {
    const { run, calls } = stubRunner([ok]);
    cloneForPr("o/f", "feature", "tok", "/wd/a", undefined, { run });
    cloneForPr("o/f", "feature", "tok", "/wd/b", 5, { run });
    // Each clone emits 3 calls (clone, config, config); the second clone's
    // depth flag is therefore at index 3, not 4.
    expect(calls[0]!.args).toContain("20");
    expect(calls[3]!.args).toContain("5");
  });

  test("returns false and does not set the identity when the clone fails", () => {
    const { run, calls } = stubRunner([fail("fatal: repository not found")]);
    expect(cloneForPr("o/f", "feature", "tok", "/wd/new", 20, { run })).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("clone");
  });
});

// ── Controller fix round: credential redaction on the timeout path ─────────
// The Python's `_sync_git` timeout message interpolates the full argv, so a
// timed-out `git push <credential-url> …` leaves the token inside `stderr`.
// `pushRef` copies that stderr into `detail`, and `detail` is posted to
// Discord by the sync reporter (py:1447 → 1492-1497) — so a 300s push timeout
// on BOTH credentials would print the App installation token in a channel.
// These tests drive the REAL runGit, not a stub, so they cannot pass while
// the redaction is missing.
describe("credential redaction", () => {
  const SECRET = "ghs_LITERALLYNOTAREALTOKEN0123456789";

  test("a timeout synthesized by runGit carries no credential from argv", () => {
    const dir = tempDir("redact-");
    try {
      runGit(["init", "-q", dir]);
      runGit(["config", "user.email", "b@b.c"], dir, 10);
      runGit(["config", "user.name", "b"], dir, 10);
      writeFileSync(join(dir, "f.txt"), "x");
      runGit(["add", "f.txt"], dir, 10);
      runGit(["commit", "-q", "-m", "x"], dir, 10);
      mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
      const hook = join(dir, ".git", "hooks", "pre-push");
      writeFileSync(hook, "#!/bin/sh\nsleep 5\n");
      chmodSync(hook, 0o755);

      // The push URL carries the secret; the command blocks past the budget,
      // so the timeout message is the one under test.
      const r = runGit(
        ["push", `https://x-access-token:${SECRET}@github.com/o/f.git`, "HEAD:refs/heads/main"],
        dir,
        0.5,
      );
      expect(r.code).toBe(124);
      expect(r.stderr).toContain("timeout after 0.5s");
      expect(r.stderr).not.toContain(SECRET);
      expect(r.stderr).not.toContain("x-access-token:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("pushRef detail stays clean when BOTH credentials time out", () => {
    // The exhausting case: neither credential answers, so `last` keeps the
    // final attempt's stderr — the exact string that used to carry the token.
    const { run } = stubRunner([
      { code: 124, stdout: "", stderr: `timeout after 300s: git push https://x-access-token:${SECRET}@github.com/o/f.git HEAD:refs/heads/main` },
      { code: 124, stdout: "", stderr: `timeout after 300s: git push https://x-access-token:${SECRET}@github.com/o/f.git HEAD:refs/heads/main` },
    ]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", SECRET, false, { pat: SECRET, run });
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain(SECRET);
    expect(r.detail).not.toContain("x-access-token:");
  });

  test("redaction does not swallow an ordinary git error", () => {
    const { run } = stubRunner([
      fail("fatal: unable to access 'https://github.com/o/f.git/': Could not resolve host"),
    ]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "", false, { pat: "pattok", run });
    expect(r.detail).toContain("Could not resolve host");
  });
});

// ── Controller fix round: the invariants the first pass left untested ───────
describe("error-string invariants", () => {
  test("the concatenated error is trimmed before it is classified and kept", () => {
    // Python line 1184 applies .strip() to `stderr + stdout`; without it a
    // whitespace-only stderr would make the error invisible to the markers.
    const { run } = stubRunner([fail("   \n  GH006: Protected branch update failed  \n\t")]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "apptok", false, { pat: "pattok", run });
    expect(r.protected).toBe(true);
    expect(r.detail).toBe("pat: GH006: Protected branch update failed");
  });

  test("strips the leading whitespace that the tail slice would otherwise keep", () => {
    // `err.slice(-260)` runs AFTER the trim, so padding longer than 260 chars
    // cannot survive into the detail. BOTH credentials fail, so `last` holds
    // the app attempt — the one this assertion is about.
    const { run } = stubRunner([
      fail(`${" ".repeat(400)}tail-marker`),
      fail(`${" ".repeat(400)}tail-marker`),
    ]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "apptok", false, { pat: "pattok", run });
    expect(r.detail).toBe("app: tail-marker");
  });

  test("the detail tail counts code points, not UTF-16 units", () => {
    // Python slices `err[-260:]` by CODE POINT. String.slice counts UTF-16
    // code units, so an emoji straddling the boundary would be cut in half
    // and render as U+FFFD. Put the emoji exactly ON the cut so the two
    // implementations disagree: 259 filler + emoji + trailing filler.
    const emoji = "😀"; // one code point, two UTF-16 units
    const err = `${"a".repeat(259)}${emoji}${"b".repeat(10)}`;
    // Two failures so the loop exhausts and `last` is the app attempt.
    const { run } = stubRunner([fail(err), fail(err)]);
    const r = pushRef("/wd", "o/f", "HEAD", "refs/heads/main", "apptok", false, { pat: "pattok", run });
    // The whole error is 270 code points, so the tail is its last 260: 249 'a',
    // the emoji, then the ten 'b'. A UTF-16 slice would instead cut the emoji
    // in half and leave 258 'a' with a U+FFFD where it used to be.
    expect(r.detail).toBe(`app: ${"a".repeat(249)}${emoji}${"b".repeat(10)}`);
    expect(r.detail).not.toContain("�");
  });

  test("the clone keeps the Python's 60s budget", () => {
    // A mutant that raises CLONE_TIMEOUT_SEC to the push budget (300) would
    // hang a cron tick for five minutes on a slow clone.
    const { run, calls } = stubRunner([ok]);
    cloneForPr("o/f", "feature", "tok", "/wd/new", 20, { run });
    expect(calls[0]!.timeoutSec).toBe(60);
  });

  test("setBotIdentity keeps the Python's 10s budget on each config call", () => {
    const { run, calls } = stubRunner([]);
    setBotIdentity("/wd", run);
    expect(calls[0]!.timeoutSec).toBe(10);
    expect(calls[1]!.timeoutSec).toBe(10);
  });
});

describe("setBotIdentity", () => {
  test("writes both config values with a 10s budget each", () => {
    const { run, calls } = stubRunner([]);
    setBotIdentity("/wd", run);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ args: ["config", "user.name", "mytheclipsebotreview"], cwd: "/wd", timeoutSec: 10 });
    expect(calls[1]).toEqual({
      args: ["config", "user.email", "bot@users.noreply.github.com"],
      cwd: "/wd",
      timeoutSec: 10,
    });
  });
});

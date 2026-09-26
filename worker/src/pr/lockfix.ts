/**
 * Lockfile pre-fixes for trivial (dependabot) PRs — port of
 * `scripts/pr-queue-worker.py` lines 589-597 (`is_trivial_pr`), 608-624
 * (`_repo_has_bun_lock`), 627-706 (`fix_uv_lock_for_trivial_pr`) and 709-791
 * (`fix_bun_lock_for_trivial_pr`).
 *
 * THE PROBLEM. Dependabot bumps `package.json` but not the lockfile, and bun /
 * uv re-resolve dependencies at install time, so CI's frozen-lockfile install
 * rejects the PR even though the code is fine. Both fixes are the same shape —
 * clone the branch, merge the base in (to match CI's merge state), re-resolve,
 * commit ONLY the lockfile, push — and they are kept separate because they
 * differ in five load-bearing details: the clone depth (5 / none), the merge
 * flags (`--no-edit` vs `--no-edit --no-ff`), the `git add` (`-A` vs
 * `bun.lock`), the commit message, and the "nothing to commit" tolerance.
 *
 * FOUR INVARIANTS:
 *
 * 1. TRUNCATION WIDTHS DIFFER PER SITE and are carried individually, each
 *    citing its Python line. Note `stderr[-300:][:100]` on the two lock
 *    commands: the TAIL is taken first and the HEAD of that, so the last words
 *    of a long error do NOT reach the summary. That reads like a bug and is
 *    what the Python reports today.
 * 2. CREDENTIALS ARE REDACTED OUT OF EVERY SUMMARY. A clone/push error echoes
 *    the credential URL back, and a summary reaches the ops Discord channel
 *    (report.ts). The Python inherited this leak (worker fix cc15d06); every
 *    stderr/stdout fragment below passes through `reportable` first.
 * 3. EVERY EXIT PATH REMOVES THE WORKDIR. The Python `rm -rf`s before each
 *    return, and a leaked clone is a leaked process tree.
 * 4. NO MODULE-SCOPE EFFECTS. `process.env` and the filesystem are reached only
 *    through the injected `deps`. Bun snapshots `homedir()` at process start, so
 *    a module-scope secret read made a suite pass only on the machine that
 *    happened to hold the real credential (the Task 8 lesson). Task 14 wires
 *    the real implementations.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { redactCredentials, setBotIdentity, tail, type GitResult, type GitRunner } from "../git";
import type { GhClient } from "./scan";

/** Python `TMP_BASE` (line 67). The parent of all three workdirs. */
export const TMP_BASE = "/tmp/pr-queue-work";

// ── Timeout budgets ─────────────────────────────────────────────────────────
// One per Python `subprocess.run(..., timeout=N)`, each with its line cited.
// None of them is the same number; a shared default would be a guess, and a
// guess here changes how long a cron tick can hang.
const CLONE_TIMEOUT_SEC = 60; // 647-650, 735-738
const FETCH_TIMEOUT_SEC = 30; // 659-660, 747
const MERGE_TIMEOUT_SEC = 30; // 661-662, 748-749
const ABORT_TIMEOUT_SEC = 15; // 665, 751
const UV_LOCK_TIMEOUT_SEC = 180; // 670
const FROZEN_INSTALL_TIMEOUT_SEC = 120; // 756
const BUN_INSTALL_TIMEOUT_SEC = 180; // 762
const DIFF_TIMEOUT_SEC = 15; // 678, 769
const ADD_TIMEOUT_SEC = 15; // 691, 776
const COMMIT_TIMEOUT_SEC = 30; // 692-695, 777-780
const PUSH_TIMEOUT_SEC = 60; // 700-701, 785-786
/** Python `clone ... "--depth", "5"` (line 648) — the uv lockfix clone only. */
const LOCKFIX_DEPTH = 5;

// ── Summary slice widths, one per Python site ───────────────────────────────
const STDERR_TAIL = 300; // `stderr[-300:]` — 673, 764
const DETAIL = 100; // `[:100]` of that tail — 675, 766, 698, 706, 783, 791
const FILE_CAP = 3; // `changed[:3]` — 689, 774

// ── Shared injection types (autofix.ts imports these) ──────────────────────

/**
 * The workdir + PID-file lifecycle, narrowed to the five operations these
 * flows need. `nodeWorkdirs()` is the real implementation, for the Task 14
 * wiring.
 */
export type Workdirs = {
  exists(path: string): boolean;
  mkdir(path: string): void;
  /** `rm -rf` in the Python, and `unlink(missing_ok=True)` for the pid file. */
  remove(path: string): void;
  writeFile(path: string, contents: string): void;
  readFile(path: string): string;
};

/**
 * A non-git program (`uv lock`, `bun install`). Same result shape as
 * `GitRunner` because the Python has one `subprocess.run` for both, but kept as
 * its own type so a test's two namespaces stay legible.
 */
export type ProcRunner = (args: string[], cwd?: string, timeoutSec?: number) => GitResult;

/** What `fixUvLock` / `fixBunLock` need from the world. */
export type LockfixDeps = {
  /** Git. Never throws (git.ts). */
  run: GitRunner;
  /** `uv` / `bun`. Never throws. */
  exec: ProcRunner;
  workdirs: Workdirs;
  /** Python `_fetch_gh_token()` (lines 599-605). `""` means "no PAT". */
  fetchGhToken: () => string;
};

/**
 * Python's `err[:n]`, by CODE POINT.
 *
 * `String.prototype.slice` counts UTF-16 code units, so an emoji on the boundary
 * is cut in half and renders as U+FFFD — the mirror image of `git.ts`'s `tail`,
 * which exists for the same reason. Exported because `autofix.ts` needs the
 * same semantics for its `[:200]` / `[:300]` summaries.
 */
export function head(text: string, n: number): string {
  const points = [...text];
  return points.length <= n ? text : points.slice(0, n).join("");
}

/**
 * The single door between a command's output and a reported summary. Narrow by
 * design, like `redactCredentials`: only http(s) URL userinfo is rewritten, so
 * an ordinary git or bun error stays diagnosable.
 */
export function reportable(text: string): string {
  return redactCredentials(text);
}

/** Python `[f.strip() for f in stdout.split("\n") if f.strip()]` (lines 679, 770). */
function changedPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/** Python `any("uv.lock" in f for f in changed)` (686) / `bun.lock` (771). */
const touches = (paths: string[], needle: string): boolean =>
  paths.some((p) => p.includes(needle));

/**
 * The credentialed clone URL — Python lines 646, 734 and 838, all one f-string.
 * Kept byte-identical to `git.ts`'s private `credentialUrl`.
 */
const credentialUrl = (token: string, repo: string): string =>
  `https://x-access-token:${token}@github.com/${repo}.git`;

/**
 * The clone, returning the RESULT rather than a boolean.
 *
 * WHY NOT `git.ts`'s `cloneForPr`: two of the three clone sites quote the
 * clone's STDERR in their summary (lines 741, 845), which a boolean cannot
 * carry, and the bun site passes no `--depth` at all (line 736) where
 * `cloneForPr` always emits one. Both are facts about the Python, so the argv is
 * rebuilt here: same order (`clone`, url, dir, THEN `--branch`/`--depth`), same
 * 60s budget, same post-clone bot identity. `depth: null` omits the flag.
 */
export function clonePr(
  run: GitRunner,
  repo: string,
  branch: string,
  token: string,
  workdir: string,
  depth: number | null,
): GitResult {
  const args = ["clone", credentialUrl(token, repo), workdir, "--branch", branch];
  if (depth !== null) args.push("--depth", String(depth));
  const r = run(args, undefined, CLONE_TIMEOUT_SEC);
  if (r.code === 0) setBotIdentity(workdir, run); // Python lines 743-744 / 847-848
  return r;
}

/**
 * The real `Workdirs`, on node:fs. Built lazily by the Task 14 wiring, so a
 * test that injects its own never touches the disk.
 */
export function nodeWorkdirs(): Workdirs {
  return {
    // `statSync`, not `existsSync`: a broken symlink is a real leftover workdir
    // that `existsSync` reports as absent, and Python's `Path.exists()` follows
    // symlinks the way `statSync` does.
    exists: (p) => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    },
    // Python's `mkdir(parents=True, exist_ok=True)`.
    mkdir: (p) => {
      mkdirSync(p, { recursive: true });
    },
    // Python's `rm -rf`, and `unlink(missing_ok=True)` for the pid file —
    // `force: true` covers both without a branch.
    remove: (p) => {
      rmSync(p, { recursive: true, force: true });
    },
    writeFile: (p, c) => {
      writeFileSync(p, c);
    },
    readFile: (p) => readFileSync(p, "utf8"),
  };
}

// ── is_trivial_pr ───────────────────────────────────────────────────────────

/**
 * Python `is_trivial_pr(title, author)` (lines 589-597): "Skip AI fix for
 * trivial PRs (dependabot bumps, docs-only, etc.)".
 *
 * The keyword list is transcribed verbatim and in order. Matching is a
 * SUBSTRING test against the LOWERCASED title, so "update" also matches
 * "refactor: update the parser" — a false positive, and the Python's behaviour.
 * This port does not get to fix it: a narrower rule changes which PRs reach the
 * AI agent, which changes cost and merge outcomes.
 *
 * `author` IS DELIBERATELY UNUSED. Python never reads it; adding an author check
 * would be a behaviour change disguised as a fix. It stays in the signature
 * because the pipeline calls it with an author (line 1912).
 */
export function isTrivialPr(title: string, author: string): boolean {
  const trivialKw = [
    "dependabot",
    "update",
    "bump",
    "chore(deps)",
    "pin dependencies",
    "update version",
    "docs:",
    "readme",
    "changelog",
  ];
  // `String(...)` mirrors Python's `str(title)`, so a null/undefined/number
  // title degrades instead of throwing inside a cron tick.
  const titleLower = String(title).toLowerCase();
  for (const kw of trivialKw) {
    if (titleLower.includes(kw)) return true; // Python line 595
  }
  return false; // Python line 597
}

// ── _repo_has_bun_lock ──────────────────────────────────────────────────────

/**
 * Python `_repo_has_bun_lock(token, repo_full, sha)` (lines 608-624): "True if
 * the repo's tree at `sha` contains a bun.lock (root or any workspace)".
 *
 * Read-only, and EVERY failure means "no": a non-200, a malformed body, or a
 * thrown request all fall into the single `except Exception: pass` at lines
 * 622-623. The port keeps that — this predicate only chooses WHICH lockfix to
 * try, so a false negative costs one extra uv attempt, whereas a throw would
 * abort the whole tick.
 *
 * The TREE endpoint, not the contents endpoint (line 614): it is the only way to
 * see a workspace's bun.lock, and the recursive form returns every path at once.
 * The match is a SUBSTRING on the path (line 620), so a workspace lockfile
 * counts — and so would a file merely named `bun.lock.bak`.
 */
export async function repoHasBunLock(
  api: GhClient,
  token: string,
  repo: string,
  sha: string,
): Promise<boolean> {
  try {
    const { status, data } = await api.request("GET", `/repos/${repo}/git/trees/${sha}?recursive=1`, {
      token,
    });
    if (status === 200 && Array.isArray(data?.tree)) {
      for (const item of data.tree as any[]) {
        const path = typeof item?.path === "string" ? item.path : "";
        if (path.includes("bun.lock")) return true; // Python line 620
      }
    }
  } catch {
    /* Python lines 622-623: `except Exception: pass` */
  }
  return false; // Python line 624
}

// ── fix_uv_lock_for_trivial_pr ──────────────────────────────────────────────

/**
 * Python `fix_uv_lock_for_trivial_pr(...)` (lines 627-706).
 *
 * "For trivial PRs (dependabot) with CI failure on uv.lock check: clone branch,
 * run `uv lock`, commit & push the updated lockfile."
 *
 * Every Python early return maps to one `{ok, summary}`. Note the deliberate
 * ASYMMETRY with the bun path, all three parts of it: `git add -A` (line 691,
 * because a uv re-resolve can legitimately touch sibling lockfiles), a
 * `[skip ci]` commit message (line 693, so the push does not re-trigger the very
 * check being fixed), and NO tolerance for a failed commit (line 696).
 */
export async function fixUvLock(
  deps: LockfixDeps,
  repo: string,
  pr: number,
  headRef: string,
  baseRef: string,
): Promise<{ ok: boolean; summary: string }> {
  const { run, exec, workdirs, fetchGhToken } = deps;
  const workdir = `${TMP_BASE}/${String(repo).replace(/\//g, "_")}_lockfix_${pr}`;

  // Python lines 636-638.
  if (workdirs.exists(workdir)) workdirs.remove(workdir);
  workdirs.mkdir(workdir);

  // Python line 641: "Use gh token for auth (reliable PAT)" — this path does NOT
  // use the caller's own token for the clone, unlike the AI-fix one.
  const ghToken = fetchGhToken();
  if (!ghToken) {
    workdirs.remove(workdir);
    return { ok: false, summary: "no gh token" }; // Python line 644
  }

  const cloned = clonePr(run, repo, headRef, ghToken, workdir, LOCKFIX_DEPTH);
  if (cloned.code !== 0) {
    workdirs.remove(workdir);
    // Python line 653: the BARE string. The bun site appends stderr here; this
    // one does not, and adding it would change a summary read on a channel.
    return { ok: false, summary: "clone failed" };
  }

  // Python lines 659-662: merge the base so the lockfile matches CI's merge state.
  run(["fetch", "origin", baseRef, "--depth", "5"], workdir, FETCH_TIMEOUT_SEC);
  const merge = run(["merge", `origin/${baseRef}`, "--no-edit"], workdir, MERGE_TIMEOUT_SEC);
  if (merge.code !== 0) {
    run(["merge", "--abort"], workdir, ABORT_TIMEOUT_SEC); // Python line 665
    workdirs.remove(workdir);
    return { ok: false, summary: `merge conflict with ${baseRef}` }; // Python line 667
  }

  const locked = exec(["uv", "lock"], workdir, UV_LOCK_TIMEOUT_SEC);
  if (locked.code !== 0) {
    const stderr = reportable(locked.stderr);
    workdirs.remove(workdir);
    // Python lines 673-675: tail 300, THEN head 100 of that tail.
    return { ok: false, summary: `uv lock failed: ${head(tail(stderr, STDERR_TAIL), DETAIL)}` };
  }

  const diff = run(["diff", "--name-only"], workdir, DIFF_TIMEOUT_SEC);
  const changed = changedPaths(diff.stdout);

  if (!changed.length) {
    workdirs.remove(workdir);
    return { ok: false, summary: "no change (uv.lock already consistent)" }; // line 683
  }

  // Python lines 686-689: commit only if the LOCKFILE is among the changes. A
  // re-resolve that touched only project files means the diagnosis was wrong,
  // and pushing it would smuggle an unrelated change onto the PR.
  if (!touches(changed, "uv.lock")) {
    workdirs.remove(workdir);
    // Python line 689 interpolates a LIST, so the summary carries the first
    // three paths as an array literal.
    return { ok: false, summary: `unexpected files changed: ${JSON.stringify(changed.slice(0, FILE_CAP))}` };
  }

  run(["add", "-A"], workdir, ADD_TIMEOUT_SEC); // Python line 691
  const commit = run(
    ["commit", "-m", "chore: refresh uv.lock after dependabot bump [skip ci]"],
    workdir,
    COMMIT_TIMEOUT_SEC,
  );
  if (commit.code !== 0) {
    workdirs.remove(workdir);
    return { ok: false, summary: `commit failed: ${head(reportable(commit.stderr), DETAIL)}` };
  }

  const pushed = run(["push", "origin", `HEAD:${headRef}`], workdir, PUSH_TIMEOUT_SEC);
  workdirs.remove(workdir);

  if (pushed.code === 0) return { ok: true, summary: "uv.lock regenerated and pushed" }; // line 705
  return { ok: false, summary: `push failed: ${head(reportable(pushed.stderr), DETAIL)}` }; // line 706
}

// ── fix_bun_lock_for_trivial_pr ─────────────────────────────────────────────

/**
 * Python `fix_bun_lock_for_trivial_pr(...)` (lines 709-791).
 *
 * "Root cause (2026-08-29): dependabot bumps package.json deps but bun.lock is
 * computed/resolved at install time by bun 1.3.14 differently than when the
 * lockfile was last committed, so CI's --frozen-lockfile rejects the PR even
 * though the code is correct. Fix = re-sync bun.lock on the PR branch."
 *
 * The frozen install is the DIAGNOSIS, not a step: if it SUCCEEDS the lockfile
 * was never the problem, and the right answer is to say so and stop (line 759)
 * rather than re-resolve a consistent lockfile and push the noise. That is why
 * this path has one more branch than the uv one.
 */
export async function fixBunLock(
  deps: LockfixDeps,
  repo: string,
  pr: number,
  headRef: string,
  baseRef: string,
): Promise<{ ok: boolean; summary: string }> {
  const { run, exec, workdirs, fetchGhToken } = deps;
  const workdir = `${TMP_BASE}/${String(repo).replace(/\//g, "_")}_bunfix_${pr}`;

  if (workdirs.exists(workdir)) workdirs.remove(workdir); // Python lines 725-727
  workdirs.mkdir(workdir);

  const ghToken = fetchGhToken(); // Python line 729
  if (!ghToken) {
    workdirs.remove(workdir);
    return { ok: false, summary: "no gh token" }; // Python line 732
  }

  // NO `--depth` here (line 736): a frozen install that has to re-resolve a
  // large monorepo graph needs real history, and the uv site's 5 is not a
  // transferable default. Hence `null` rather than a number.
  const cloned = clonePr(run, repo, headRef, ghToken, workdir, null);
  if (cloned.code !== 0) {
    workdirs.remove(workdir);
    // Python line 741: 200 characters, not the uv site's bare string and not
    // the DETAIL width either.
    return { ok: false, summary: `clone failed: ${head(reportable(cloned.stderr), 200)}` };
  }

  run(["fetch", "origin", baseRef], workdir, FETCH_TIMEOUT_SEC); // Python line 747
  const merge = run(
    ["merge", `origin/${baseRef}`, "--no-edit", "--no-ff"],
    workdir,
    MERGE_TIMEOUT_SEC,
  );
  if (merge.code !== 0) {
    run(["merge", "--abort"], workdir, ABORT_TIMEOUT_SEC); // Python line 751
    workdirs.remove(workdir);
    return { ok: false, summary: `merge conflict with ${baseRef}` }; // Python line 753
  }

  const frozen = exec(["bun", "install", "--frozen-lockfile"], workdir, FROZEN_INSTALL_TIMEOUT_SEC);
  if (frozen.code === 0) {
    workdirs.remove(workdir);
    return {
      ok: false,
      summary: "bun.lock already consistent with package.json (CI failure elsewhere)",
    }; // Python line 759
  }

  const sync = exec(["bun", "install"], workdir, BUN_INSTALL_TIMEOUT_SEC);
  if (sync.code !== 0) {
    const stderr = reportable(sync.stderr);
    workdirs.remove(workdir);
    return { ok: false, summary: `bun install sync failed: ${head(tail(stderr, STDERR_TAIL), DETAIL)}` };
  }

  const diff = run(["diff", "--name-only"], workdir, DIFF_TIMEOUT_SEC);
  const changed = changedPaths(diff.stdout);
  if (!touches(changed, "bun.lock")) {
    workdirs.remove(workdir);
    return {
      ok: false,
      summary: `bun install ran but bun.lock unchanged (unexpected files: ${JSON.stringify(changed.slice(0, FILE_CAP))})`,
    }; // Python line 774
  }

  // `git add bun.lock`, NOT `-A`: the uv site stages everything because a uv
  // re-resolve legitimately touches sibling lockfiles, whereas here anything
  // else bun wrote is a build artefact that must not ride along.
  run(["add", "bun.lock"], workdir, ADD_TIMEOUT_SEC); // Python line 776
  const commit = run(
    ["commit", "-m", "chore: sync bun.lock after dependabot bump"],
    workdir,
    COMMIT_TIMEOUT_SEC,
  );
  // Python line 781. The tolerance is real and asymmetric with the uv site: a
  // concurrent push can leave the worktree clean between the diff and the
  // commit, and here that is a benign no-op rather than a failure to report.
  if (commit.code !== 0 && !commit.stderr.includes("nothing to commit")) {
    workdirs.remove(workdir);
    return { ok: false, summary: `commit failed: ${head(reportable(commit.stderr), DETAIL)}` };
  }

  const pushed = run(["push", "origin", `HEAD:${headRef}`], workdir, PUSH_TIMEOUT_SEC);
  workdirs.remove(workdir);

  if (pushed.code === 0) return { ok: true, summary: "bun.lock regenerated and pushed" }; // line 790
  return { ok: false, summary: `push failed: ${head(reportable(pushed.stderr), DETAIL)}` }; // line 791
}

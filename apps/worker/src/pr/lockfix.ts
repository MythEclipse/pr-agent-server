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
import { redactCredentials, setBotIdentity, type GitResult, type GitRunner } from "../git.ts";
import type { GhClient } from "./scan.ts";

/** Python `TMP_BASE` (line 67). The parent of all three workdirs. */
export const TMP_BASE = "/tmp/pr-queue-work";

// `CLONE_TIMEOUT_SEC` is the one budget that stays here: it belongs to
// `clonePr` below. The rest of the lockfix budgets live in `./relock`,
// with the bodies that cite them.
const CLONE_TIMEOUT_SEC = 60; // 647-650, 735-738
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
export function isTrivialPr(title: string, _author: string): boolean {
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
import { fixBunLock, fixUvLock } from "./relock.ts";

// Re-exported so `pipeline.ts` and the test suite keep importing the two
// flows from `./lockfix`. This is a live re-export and `./relock` imports
// `clonePr`/`head`/`reportable` back, so the two modules form an ESM cycle;
// it is safe because nothing either module reads is touched at
// module-evaluation time.
export { fixBunLock, fixUvLock };


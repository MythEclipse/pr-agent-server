/**
 * The two lockfile re-resolve-and-push flows for trivial (dependabot) PRs.
 *
 * Extracted verbatim from `./lockfix` so that file comes back under the 400-line
 * cap. THIS IS A MOVE, NOT A REWRITE. `fixUvLock` and `fixBunLock` are a
 * line-by-line port of `scripts/pr-queue-worker.py` lines 627-706 and 709-791,
 * and parity with that Python is a BINDING CONTRACT: the summary strings, the
 * TAIL-then-HEAD truncation order (`stderr[-300:]` then `[:100]`), the
 * `git add -A` vs `git add bun.lock` asymmetry, and the "nothing to commit"
 * tolerance are all facts about the Python, not preferences. Nothing here was
 * tidied, renamed or re-ordered.
 *
 * The budgets and the slice widths moved WITH the bodies because each is cited
 * to a `subprocess.run(..., timeout=N)` or a `[:n]` that now lives here, and
 * because a shared default would be a guess that changes how long a cron tick
 * can hang. `CLONE_TIMEOUT_SEC` stays in `./lockfix` with `clonePr`, the only
 * clone helper that stayed there.
 *
 * `./lockfix` keeps the shared injection types, `head`/`reportable`, `clonePr`
 * and `nodeWorkdirs`, because `autofix.ts`, `index.ts`, `pipeline.ts` and the
 * sync modules all import those from there; it re-exports the two flows below so
 * those import sites need no edit.
 */

import { tail } from "../git.ts";
import { TMP_BASE, clonePr, head, reportable, type LockfixDeps } from "./lockfix.ts";

// ── Timeout budgets ─────────────────────────────────────────────────────────
// One per Python `subprocess.run(..., timeout=N)`, each with its line cited.
// None of them is the same number; a shared default would be a guess, and a
// guess here changes how long a cron tick can hang.
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

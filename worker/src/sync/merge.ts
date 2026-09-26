/**
 * Merge mechanics for the upstream sync — port of `scripts/pr-queue-worker.py`
 * lines 1318-1365 (`_sync_unmerged_files`, `_sync_has_conflict_markers`,
 * `_sync_finish_merge`, `_sync_commit_if_dirty`), 1366-1426 (the two prompts),
 * 1427-1450 (`_sync_revert_merge`) and 1143-1149 (`_sync_fetch_url`).
 *
 * FOUR THINGS IN HERE ARE POLICY, NOT MECHANICS. They read like they could be
 * simplified and must not be:
 *
 * 1. THE MERGE IS NEVER RESOLVED WITH `--ours`/`--theirs`, AND NEVER REBASED.
 *    The whole feature is that a fork keeps its local divergence intact
 *    (Python lines 963-984). A wholesale side-pick is not a "simplification",
 *    it is the bug the feature exists to avoid. Both prompts say so, verbatim.
 * 2. `git grep` EXITS 1 WHEN NOTHING MATCHES, AND THAT IS THE HEALTHY CASE.
 *    The scan therefore branches THREE ways (lines 1331-1333): 0 → markers
 *    found, 1 → clean, anything else → `[]` WITHOUT reading stdout. A naive
 *    `code === 0 ? stdout : ""` looks equivalent and is not: on exit 2 git
 *    itself failed (not a repository, a bad path), and treating that as "no
 *    markers" would let `_syncFinishMerge` commit a conflicted file. Returning
 *    `[]` is what the Python does, and it is deliberately the same answer as
 *    "clean" — the asymmetry that matters is that exit 2 never reaches the
 *    parse at all.
 * 3. A FILE THE AGENT `git add`ED MID-RESOLUTION STILL PASSES THE UNMERGED
 *    CHECK. The marker scan is the second guard, and it exists for exactly that
 *    case: `git diff --diff-filter=U` stops listing a staged file, so
 *    `_syncFinishMerge` could otherwise commit `<<<<<<<` into main. Two
 *    distinct refusal messages, each slicing its list to 5 (lines 1341, 1344).
 * 4. THE REVERT IS SHA-GUARDED BY ITS CALLER, not here (lines 1427-1429). This
 *    function verifies the pre-merge commit is REACHABLE in the clone and
 *    force-pushes it; whether the branch tip is still our merge commit is
 *    `verifyPendingSyncs`' question. Moving that guard here would be a new
 *    behaviour, and a wrong one: a revert that "checks the tip" and finds a
 *    human commit on top would have to silently do nothing, which is a
 *    different contract from refusing to be called.
 */
import { redactCredentials, pushRef, type GitRunner } from "../git";
import { head, type Workdirs } from "../pr/lockfix";

// ── Constants ────────────────────────────────────────────────────────────────

/** Python `SYNC_PR_PREFIX` (line 987). */
export const SYNC_PR_PREFIX = "upstream-sync-";
/** Python `SYNC_TMP_BASE` (line 986). */
export const SYNC_TMP_BASE = "/tmp/pr-queue-sync-work";

/** Python `SYNC_CLAUDE_TIMEOUT` (line 988) — 3600, and the reason for it. */
const SYNC_CLAUDE_TIMEOUT = 3600;

/** Python `git grep -E '^(<<<<<<<|>>>>>>>|=======)$'` (line 1329), VERBATIM. */
const CONFLICT_MARKER_PATTERN = "^(<<<<<<<|>>>>>>>|=======)$";

/** One budget per Python `subprocess.run(..., timeout=N)`; none is a guess. */
const UNMERGED_TIMEOUT_SEC = 60; // 1319
const MARKER_TIMEOUT_SEC = 60; // 1329
const FINISH_ADD_TIMEOUT_SEC = 120; // 1345
const FINISH_COMMIT_TIMEOUT_SEC = 120; // 1346
const DIRTY_STATUS_TIMEOUT_SEC = 60; // 1358
const DIRTY_ADD_TIMEOUT_SEC = 120; // 1361
const DIRTY_COMMIT_TIMEOUT_SEC = 120; // 1362
const REVERT_CLONE_TIMEOUT_SEC = 300; // 1435
const REVERT_CATFILE_TIMEOUT_SEC = 60; // 1439

/** Python `[:5]` in both refusal messages — a cap, not a filter (1341, 1344). */
const FILE_CAP = 5;
/** Python `conflicted[:40]` in the conflict prompt (line 1373). */
const CONFLICT_PROMPT_CAP = 40;
/** Python `files[:30]` in the quality prompt (line 1408). */
const QUALITY_PROMPT_CAP = 30;
/** Python `(stderr or '').strip()[:160]` on a failed revert clone (line 1437). */
const REVERT_CLONE_DETAIL = 160;
/** Python `detail[:200]` on a failed revert push (line 1446). */
const REVERT_PUSH_DETAIL = 200;
/** Python `[:200]` on the `_sync_finish_merge` commit failure (line 1351). */
const COMMIT_DETAIL = 200;

// ── The state probes ──────────────────────────────────────────────────────────

/** Python `[f for f in (r.stdout or "").split("\n") if f.strip()]` (line 1320). */
const lines = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

/**
 * Python `_sync_unmerged_files(workdir)` (lines 1318-1320): the paths git still
 * considers unmerged. `--diff-filter=U` is the only source of truth here; the
 * exit code is deliberately IGNORED, because a non-zero from `git diff` here
 * means the listing is empty (a clean tree exits 0 with no output, a failure
 * exits non-zero with no stdout) and both read the same.
 */
export function syncUnmergedFiles(run: GitRunner, workdir: string): string[] {
  return lines(run(["diff", "--name-only", "--diff-filter=U"], workdir, UNMERGED_TIMEOUT_SEC).stdout);
}

/**
 * Python `_sync_has_conflict_markers(workdir)` (lines 1323-1336): "Tracked
 * files that still contain conflict markers. A file the agent `git add`ed
 * mid-resolution would pass the unmerged check while still carrying
 * `<<<<<<<` — never commit that."
 *
 * THE THREE-WAY BRANCH IS LOAD-BEARING — see note 2 in the file header. `0` is
 * "found", `1` is "git grep found nothing, which is the goal", and anything
 * else is "git itself failed", where the Python returns `[]` WITHOUT parsing
 * stdout. Collapsing the last two cases into "clean" is the bug this
 * function is shaped to prevent.
 */
export function syncHasConflictMarkers(run: GitRunner, workdir: string): string[] {
  const r = run(
    ["grep", "-l", "-E", CONFLICT_MARKER_PATTERN],
    workdir,
    MARKER_TIMEOUT_SEC,
  );
  if (r.code !== 0 && r.code !== 1) return []; // Python line 1332
  return lines(r.stdout);
}

/** Python `_sync_finish_merge`'s `(ok, detail)`. */
export type MergeOutcome = { ok: boolean; detail: string };

/**
 * Python `_sync_finish_merge(workdir)` (lines 1337-1354): "Complete an
 * in-progress merge once every conflict is resolved."
 *
 * Called on BOTH the agent-succeeded and the salvage path, which is why it is
 * the single place the two guards live.
 *
 * THE `nothing to commit` TOLERANCE (lines 1347-1350) is asymmetric with the
 * other lockfix sites and deliberate: the agent normally runs `git commit`
 * itself (rule 6 of the conflict prompt), so by the time the worker calls
 * `finish`, the merge is often ALREADY committed and this commit exits 1 with
 * "nothing to commit". That is success, not failure — the Python returns
 * `(True, "")`. The check is on `stdout + stderr` LOWERCASED, because git
 * writes the phrase to stderr with its own capitalisation.
 */
export function syncFinishMerge(run: GitRunner, workdir: string): MergeOutcome {
  const unmerged = syncUnmergedFiles(run, workdir);
  if (unmerged.length) {
    return {
      ok: false,
      detail: `${unmerged.length} file(s) still unmerged: ${unmerged.slice(0, FILE_CAP).join(", ")}`,
    };
  }
  const marked = syncHasConflictMarkers(run, workdir);
  if (marked.length) {
    return {
      ok: false,
      detail: `conflict markers left in: ${marked.slice(0, FILE_CAP).join(", ")}`,
    };
  }
  run(["add", "-A"], workdir, FINISH_ADD_TIMEOUT_SEC);
  const r = run(["commit", "--no-edit"], workdir, FINISH_COMMIT_TIMEOUT_SEC);
  if (r.code !== 0) {
    const combined = `${r.stdout || ""}${r.stderr || ""}`.toLowerCase();
    if (combined.includes("nothing to commit")) return { ok: true, detail: "" };
    // Python line 1351: `(r.stderr or r.stdout) or ""`, then [:200].
    return { ok: false, detail: head(r.stderr || r.stdout || "", COMMIT_DETAIL) };
  }
  return { ok: true, detail: "" };
}

/**
 * Python `_sync_commit_if_dirty(workdir, message)` (lines 1355-1365): "Commit
 * pending edits made by a quality pass. Returns True if a commit was created
 * (Claude normally commits itself; this is the safety net)."
 *
 * The return value is what the caller reports as "the quality pass committed"
 * vs "made no changes", so it is a real signal and not a convenience: the
 * worktree is checked FIRST, and a clean worktree returns false WITHOUT
 * running a commit that would fail. The commit's exit code is ignored in the
 * Python and here — the worktree was dirty a moment ago, and the detail of a
 * failure is not worth a report line.
 */
export function syncCommitIfDirty(run: GitRunner, workdir: string, message: string): boolean {
  const st = run(["status", "--porcelain"], workdir, DIRTY_STATUS_TIMEOUT_SEC);
  if (!(st.stdout || "").trim()) return false;
  run(["add", "-A"], workdir, DIRTY_ADD_TIMEOUT_SEC);
  run(["commit", "--message", message], workdir, DIRTY_COMMIT_TIMEOUT_SEC);
  return true;
}

// ── The prompts ──────────────────────────────────────────────────────────────

/**
 * Python `_conflict_prompt(fork, parent, upstream_branch, local_branch,
 * conflicted)` (lines 1366-1404).
 *
 * TRANSCRIBED VERBATIM AND NOT REFORMATTED. Every clause is policy the merge
 * depends on: the classification contract (keep BOTH for disjoint intent, never
 * invent a hybrid), the non-negotiable rules (hand-merge, no `--ours`/
 * `--theirs`, no rebase, no drive-by edits, strip the BOM, verify before
 * committing, do not push), and the report the agent owes back. Rule 5 names
 * the concrete commands because a generic "run the tests" produced agents that
 * skipped verification; rule 4 names the byte sequence because a BOM is
 * invisible in a diff and silently breaks the file.
 */
export function conflictPrompt(
  fork: string,
  parent: string,
  upstreamBranch: string,
  localBranch: string,
  conflicted: string[],
): string {
  const files = conflicted
    .slice(0, CONFLICT_PROMPT_CAP)
    .map((f) => "  - " + f)
    .join("\n");
  const more =
    conflicted.length <= CONFLICT_PROMPT_CAP
      ? ""
      : `\n  ... and ${conflicted.length - CONFLICT_PROMPT_CAP} more`;
  return (
    "A `git merge` is IN PROGRESS inside this repository and stopped with conflicts.\n" +
    `Direction: ${parent} (branch ${upstreamBranch}) → ${fork} (branch ${localBranch}).\n` +
    "You are the neutral reconciler: neither side may be dropped.\n\n" +
    `Conflicted files:\n${files}${more}\n\n` +
    "TASK: resolve every conflict, then finish the merge.\n\n" +
    "CLASSIFY EVERY HUNK before editing, then resolve by class:\n" +
    "  • disjoint-intent — the two changes serve different goals → keep BOTH.\n" +
    "  • same-question-different-answer — both sides answered one question\n" +
    "    differently → pick the one matching the fork's stated intent and note\n" +
    "    the decision; never invent a hybrid nobody asked for.\n" +
    "  • superseded — one side's premise no longer holds after the other change\n" +
    "    → keep the surviving side and record why.\n\n" +
    "RULES (non-negotiable):\n" +
    "1. Merge conflicting hunks by hand. NEVER `git checkout --ours/--theirs`\n" +
    "   wholesale, never `git rebase`, never delete a side without saying why.\n" +
    "2. The fork carries local features upstream does not know about: every\n" +
    "   fork-only feature must still work after the merge.\n" +
    "3. Change NOTHING outside conflict markers — no reformatting, no renames,\n" +
    "   no opportunistic fixes.\n" +
    "4. If a file starts with a UTF-8 BOM (bytes EF BB BF), strip it.\n" +
    "5. VERIFY before committing: run the repository's own checks when they\n" +
    "   exist (package.json scripts: `bun run typecheck`, `bun test`; else\n" +
    "   `npm test`, `cargo test`, `pytest -q`). Fix what YOUR resolution broke\n" +
    "   until they pass.\n" +
    "6. Complete the merge: `git add -A && git commit --no-edit`\n" +
    "7. Do NOT push — the harness pushes after you finish.\n\n" +
    "Finish with a report listing, per file, the hunks you resolved and which\n" +
    "side(s) you kept, the verification commands you ran, and their results."
  );
}

/**
 * Python `_quality_prompt(fork, parent, upstream_branch, files)` (lines
 * 1407-1424), also verbatim.
 *
 * "The merge itself is already committed and correct" is the load-bearing
 * sentence: this pass runs AFTER a clean merge, so the agent must improve
 * style without re-litigating the merge — a prompt that implied the merge was
 * unfinished produced agents that reverted upstream changes. The commit
 * message is exact because the caller matches on `[skip ci]`.
 */
export function qualityPrompt(
  fork: string,
  parent: string,
  upstreamBranch: string,
  files: string[],
): string {
  let fileList = files
    .slice(0, QUALITY_PROMPT_CAP)
    .map((f) => "  - " + f)
    .join("\n");
  if (files.length > QUALITY_PROMPT_CAP) {
    fileList += `\n  ... and ${files.length - QUALITY_PROMPT_CAP} more`; // line 1409
  }
  return (
    `The fork ${fork} just merged ${parent} (branch ${upstreamBranch}) into its\n` +
    "default branch. The merge itself is already committed and correct.\n\n" +
    `Files the merge changed:\n${fileList}\n\n` +
    "TASK: improve code quality of ONLY these files — naming, DRY, error\n" +
    "handling, missing types, docstrings, clear anti-patterns.\n\n" +
    "RULES:\n" +
    "- Behavior must stay identical. Do NOT add features or change logic.\n" +
    "- Do NOT rewrite the upstream architecture; this is a fresh merge.\n" +
    "- Run the repository's checks when they exist (`bun run typecheck`,\n" +
    "  `bun test`, else `npm test`/`cargo test`/`pytest -q`) and keep them green.\n" +
    '- Commit exactly one commit: `git add -A && git commit --message="fix: auto-fix code quality [skip ci]"`\n' +
    "- Do NOT push — the harness pushes after you finish."
  );
}

// ── Credentials ──────────────────────────────────────────────────────────────

/**
 * The credentialed clone URL, byte-identical to `git.ts`'s private helper and
 * to `lockfix.ts`'s (all three are the same f-string in the Python: 1434,
 * 1535).
 */
const credentialUrl = (token: string, repo: string): string =>
  `https://x-access-token:${token}@github.com/${repo}.git`;

/**
 * Python `_sync_fetch_url(parent)` (lines 1143-1149): "Read credentials for the
 * upstream fetch — the PAT when available (private upstreams + rate limits),
 * plain HTTPS otherwise (public read needs no auth)."
 *
 * THE PAT IS NOT OPTIONAL-AESTHETIC HERE: a private upstream is simply not
 * fetchable without it, and without the PAT the fetch fails and the whole sync
 * is an error. The app token is NOT used for this fetch — it belongs to the
 * FORK, and the Python reuses the installation token for clones/pushes only.
 */
export function syncFetchUrl(parent: string, pat: string): string {
  return pat ? credentialUrl(pat, parent) : `https://github.com/${parent}.git`;
}

/** Python `_sync_revert_merge`'s `(ok, detail)`. */
export type RevertOutcome = { ok: boolean; detail: string };

export type RevertArgs = {
  /** The installation token, used for the clone and as the push fallback. */
  appToken: string;
  fork: string;
  branch: string;
  /** The fork's tip BEFORE our merge — the sha to force back to. */
  preMergeSha: string;
  /** Reported in the success detail; never used to decide anything. */
  reason: string;
  /** Python `_fetch_gh_token()` — the PAT the push tries first. */
  fetchGhToken?: () => string;
};

/**
 * Python `_sync_revert_merge(app_token, fork, branch, pre_merge_sha, reason)`
 * (lines 1427-1450): "Force the fork branch back to the pre-merge commit. Only
 * ever called when the branch tip IS our own merge commit (sha-guarded by the
 * caller)."
 *
 * THE WORKDIR IS ITS OWN, SUFFIXED `_revert` (line 1430), and it is removed
 * before the clone AND in a `finally` after it — a leaked clone here is a
 * leaked process tree plus a credentialed `.git/config` on disk.
 *
 * `cat-file -e <sha>^{commit}` (line 1439) is the guard that makes the force
 * push safe: a shallow or newly-cloned fork may not CONTAIN the pre-merge
 * commit at all, and force-pushing an unreachable sha would either fail or, on
 * a server that still had the object, silently discard every commit between.
 * The check runs BEFORE the push for that reason.
 *
 * `force: true` is the whole point (line 1443) and must never be "tidied" into
 * a fast-forward.
 */
export function syncRevertMerge(
  run: GitRunner,
  workdirs: Workdirs,
  args: RevertArgs,
): RevertOutcome {
  const { appToken, fork, branch, preMergeSha, reason } = args;
  const dir = `${SYNC_TMP_BASE}/${fork.replace(/\//g, "_")}_revert`;

  if (workdirs.exists(dir)) workdirs.remove(dir); // Python lines 1431-1432
  workdirs.mkdir(SYNC_TMP_BASE); // Python line 1433 (`workdir.parent`)

  // ONE finally for both exits, not the Python's two-stage
  // `if clone failed: return` / `try: … finally: rm` (lines 1436-1448).
  // The Python's early return at line 1437 leaks the clone directory; the next
  // invocation's `rm -rf` on line 1432 hides that, so the leak is bounded to
  // one tick. Removing on every path here is a deliberate, safe improvement —
  // the directory was created by this call seconds earlier and holds nothing
  // but a credentialed `.git/config`, so dropping it can lose no state. The
  // OUTCOME of every exit is byte-identical to the Python's.
  try {
    const cloneUrl = appToken
      ? credentialUrl(appToken, fork)
      : `https://github.com/${fork}.git`; // Python line 1434
    const r = run(
      ["clone", cloneUrl, dir, "--branch", branch],
      undefined,
      REVERT_CLONE_TIMEOUT_SEC,
    );
    if (r.code !== 0) {
      // Redacted: a clone failure can echo the credentialed URL, and this
      // detail reaches the ops Discord channel (Python lines 1491-1497).
      return {
        ok: false,
        detail: `revert clone failed: ${head(redactCredentials(r.stderr || "").trim(), REVERT_CLONE_DETAIL)}`,
      };
    }
    const have = run(
      ["cat-file", "-e", `${preMergeSha}^{commit}`],
      dir,
      REVERT_CATFILE_TIMEOUT_SEC,
    );
    if (have.code !== 0) {
      return {
        ok: false,
        detail: `pre-merge commit ${preMergeSha.slice(0, 8)} not found in clone`,
      };
    }
    const pushed = pushRef(dir, fork, preMergeSha, `refs/heads/${branch}`, appToken, true, {
      pat: args.fetchGhToken?.() ?? "",
      run,
    });
    if (pushed.ok) {
      return { ok: true, detail: `reverted ${branch} to ${preMergeSha.slice(0, 8)} (${reason})` };
    }
    return { ok: false, detail: `revert push failed: ${head(pushed.detail, REVERT_PUSH_DETAIL)}` };
  } finally {
    workdirs.remove(dir); // Python line 1448
  }
}

/**
 * The bot identity for a sync workdir — Python lines 1541-1542, two
 * `git config` calls with a **30s** budget.
 *
 * NOT `git.ts`'s `setBotIdentity`: that one uses the lockfix budget of 10s
 * (Python lines 655-656). The number differs, so the calls are re-issued here
 * rather than reusing a function whose budget is a different call site's fact.
 * The return values were ignored in the Python and are ignored here.
 */
export function setSyncIdentity(run: GitRunner, workdir: string): void {
  const budget = 30;
  run(["config", "user.name", "mytheclipsebotreview"], workdir, budget);
  run(["config", "user.email", "bot@users.noreply.github.com"], workdir, budget);
}

/** Python's `sync_fork_repo` BUFFER line for the conflict pass (line 1570). */
export const RESOLVING_LINE = (n: number): string =>
  `      🤖 resolving ${n} conflict(s) with Hermes (up to ${SYNC_CLAUDE_TIMEOUT}s)...`;

/** Python line 1612. */
export const QUALITY_LINE = (n: number): string =>
  `      🤖 Hermes quality pass on ${n} merged file(s)...`;

/** Python line 1583. */
export const SALVAGE_LINE =
  "      ♻️ agent call ended early but the merge is complete — salvaged";

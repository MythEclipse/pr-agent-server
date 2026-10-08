/**
 * The two agent prompts the upstream sync sends.
 *
 * Extracted verbatim from `./merge` so that file comes back under the 400-line
 * cap. THIS IS A MOVE, NOT A REWRITE. Both prompts are transcribed VERBATIM from
 * `scripts/pr-queue-worker.py` lines 1366-1404 and 1407-1424, and every clause is
 * policy the merge depends on: the classification contract, the non-negotiable
 * rules (hand-merge, no `--ours`/`--theirs`, no rebase, strip the BOM, verify
 * before committing, do not push), the exact commit message the caller matches
 * on `[skip ci]`, and the report the agent owes back. Not one character was
 * reworded, reflowed or tidied — the text IS the behaviour.
 *
 * The two prompt caps moved with the prompts, since each is cited to a slice
 * inside a body that now lives here. `./merge` re-exports both functions, so
 * `sync/resolve.ts` and the test suite need no edit.
 */
/** Python `conflicted[:40]` in the conflict prompt (line 1373). */
const CONFLICT_PROMPT_CAP = 40;
/** Python `files[:30]` in the quality prompt (line 1408). */
const QUALITY_PROMPT_CAP = 30;

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


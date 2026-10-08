/**
 * Merge-conflict resolution and the post-merge quality pass for one fork.
 *
 * Extracted verbatim from `syncForkRepo` in `./run` so that file comes back under
 * the 400-line cap. THIS IS A MOVE, NOT A REWRITE. Every branch, every report
 * line, every `skipNote` call, and the order they fire in are exactly what
 * `syncForkRepo` did. No threshold, no truncation width and no git argument
 * changed; the Python (1554-1622) is still the reference.
 *
 * The only structural change: the three inlined `return ["conflict-failed", …]`
 * statements become this function's own returns, so the caller can tell "stop
 * here" from "keep going". A MOVE that cannot express early exit would have
 * forced a rewrite, and that is the risk this shape avoids.
 *
 * `syncForkRepo` must treat `{ kind: "conflict-failed" }` as its own return
 * value, verbatim, including the `skipNote` string built here.
 */
import { head, reportable } from "../pr/lockfix.ts";
import type { GitRunner } from "../git.ts";
import {
  conflictPrompt,
  qualityPrompt,
  syncCommitIfDirty,
  syncFinishMerge,
  RESOLVING_LINE,
  SALVAGE_LINE,
  QUALITY_LINE,
} from "./merge.ts";
import type { SyncConfig } from "./config.ts";

/** Everything the resolution block closes over. */
export type ResolveDeps = {
  report: { push(line: string): void };
  agent: { runSync(o: Record<string, unknown>): Promise<{ ok: boolean; snippet: string }> };
  cfg: SyncConfig;
  /** `syncForkRepo`'s own deps — used only for `skipNote` and the state file. */
  skip: (note: string) => string;
  dry: boolean;
};

export type ResolveOutcome =
  | { kind: "resolved"; resolution: string }
  | { kind: "conflict-failed"; detail: string };

/** Truncation widths, carried from the Python verbatim. */
const MERGE_DIFF_TIMEOUT_SEC = 120; // 1609
const ABORT_TIMEOUT_SEC = 60; // 1562, 1587, 1598
const SNIPPET = 200;
const SHORT_SNIPPET = 120;
const SALVAGE_SNIPPET = 80;

export async function resolveMerge(
  run: GitRunner,
  workdir: string,
  conflicted: string[],
  deps: ResolveDeps,
  ctx: {
    fork: string;
    parent: string;
    upstreamBranch: string;
    localBranch: string;
    preMergeSha: string;
  },
 ): Promise<ResolveOutcome> {
  // Pulled from the injected objects so the body below is byte-for-byte what
  // `syncForkRepo` had in scope; nothing is re-derived here.
  const { agent, cfg, dry } = deps;
  const { fork, parent, upstreamBranch, localBranch, preMergeSha } = ctx;
  let resolution: string;
  if (conflicted.length) {
    if (!cfg.resolve_conflicts) {
      // Python lines 1561-1569: abort, and record a skip that is NOT
      // retried until upstream moves.
      run(["merge", "--abort"], workdir, ABORT_TIMEOUT_SEC);
      const note =
        `${conflicted.length} conflicting file(s) and conflict resolution is disabled: ` +
        `${conflicted.slice(0, 5).join(", ")}`;
      return { kind: "conflict-failed", detail: deps.skip(note) };
    }

    deps.report.push(RESOLVING_LINE(conflicted.length)); // Python line 1570
    const agentRun = await agent.runSync({
      workdir,
      prompt: conflictPrompt(fork, parent, upstreamBranch, localBranch, conflicted),
      label: "hermes_sync_conflicts",
      fork,
      dry,
    });

    if (!agentRun.ok) {
      // SALVAGE (lines 1576-1594). The agent call failed — but a timeout or
      // a gateway hiccup says nothing about the WORKDIR. Re-read the real
      // unmerged state now and let `syncFinishMerge` decide; a refusal there
      // is the only thing that aborts. `why_salvage` is unused in the Python
      // and is dropped rather than threaded.
      const salvaged = syncFinishMerge(run, workdir);
      if (salvaged.ok) {
        deps.report.push(SALVAGE_LINE); // Python line 1583
        resolution =
          `Hermes resolved ${conflicted.length} conflict(s); ` +
          `agent call ended early (${head(reportable(agentRun.snippet), SALVAGE_SNIPPET)}) ` +
          "— merge salvaged";
      } else {
        run(["merge", "--abort"], workdir, ABORT_TIMEOUT_SEC);
        return {
          kind: "conflict-failed",
          detail: deps.skip(
            `conflict resolution failed — ${head(reportable(agentRun.snippet), SNIPPET)}`
          ),
        };
      }
    } else {
      const done = syncFinishMerge(run, workdir);
      if (!done.ok) {
        run(["merge", "--abort"], workdir, ABORT_TIMEOUT_SEC);
        return {
          kind: "conflict-failed",
          detail: deps.skip(`conflict resolution incomplete — ${done.detail}`),
        };
      }
      resolution = `Hermes resolved ${conflicted.length} conflict(s)`;
    }
  } else {
    resolution = "clean merge"; // Python line 1607
    if (cfg.ai_fix_after_merge) {
      const diff = run(
        ["diff", "--name-only", `${preMergeSha}..HEAD`],
        workdir,
        MERGE_DIFF_TIMEOUT_SEC,
      );
      const mergedFiles = (diff.stdout || "")
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      if (mergedFiles.length) {
        deps.report.push(QUALITY_LINE(mergedFiles.length)); // Python line 1612
        const quality = await agent.runSync({
          workdir,
          prompt: qualityPrompt(fork, parent, upstreamBranch, mergedFiles),
          label: "hermes_sync_quality",
          fork,
          dry,
        });
        if (quality.ok) {
          const committed = syncCommitIfDirty(
            run,
            workdir,
            "fix: auto-fix code quality [skip ci]",
          );
          resolution += committed
            ? " + Hermes quality pass committed"
            : " + quality pass made no changes";
        } else {
          // The quality pass is OPTIONAL, so its failure only annotates the
          // resolution — a merge that is already correct is still pushed.
          resolution += ` (quality pass skipped: ${head(reportable(quality.snippet), SHORT_SNIPPET)})`;
        }
      }
    }
  }
  return { kind: "resolved", resolution };
}

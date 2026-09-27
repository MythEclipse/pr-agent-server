/**
 * The per-fork sweep and the outcome reporter.
 *
 * Extracted verbatim from `runUpstreamSync` in `./run` so that file comes back
 * under the 400-line cap. THIS IS A MOVE, NOT A REWRITE. The gating order, the
 * four `continue` arms, every line string, the budget decrement and the
 * reportOutcome dispatch are unchanged; the Python (1742-1826) is the reference.
 * A line-by-line diff of the loop against the original, ignoring indentation,
 * shows no hunks at all.
 *
 * `sweepForks` takes the sync implementation as an argument instead of importing
 * it, because the real one lives in `./run` — importing it here would make the
 * two modules circular. That is the one structural difference from the original.
 *
 * The budget is returned rather than mutated in a closure so the caller keeps
 * the "no budget still runs when `only` was given" rule (Python 1752-1753)
 * where it belongs.
 */
import { num, syncConfig, syncEntry } from "./config";
import type { RepoOverrides, SyncConfig, SyncState } from "./config";
import { syncOpenPr, upstreamStatus } from "./repos";
import type { SyncRequest, SyncResult, SyncForkDeps } from "./run";

/**
 * Python's `post_sync_discord(title, lines, color=0x5865F2)` default (line 1036).
 * The Python had it as a DEFAULT PARAMETER, not a named constant, so the port
 * spells it at the call site; naming it here is for the reader, and the two
 * uses in this file are the two Python call sites that pass it explicitly
 * (lines 1789 and 1815).
 */
const DISCORD_COLOR = 0x5865f2;

/** Python line 1820's amber for a skipped fork. */
const SKIP_COLOR = 0xe67e22;

/** What the outcome reporter needs to build its line and its Discord post. */
export type OutcomeCtx = {
  fork: string;
  parent: string;
  localBranch: string;
  mergeCount: number;
  upstreamSha: string;
  dry: boolean;
  entry: Record<string, unknown>;
};

/**
 * The sweep's own parameter type: exactly `SyncForkDeps` plus the two
 * `runUpstreamSync`-only fields it reads. Typing it this way (rather than a
 * hand-picked subset) means `deps` can be forwarded to `syncOne` with no cast,
 * and a field added to `SyncForkDeps` shows up here as a compile error instead of
 * a runtime undefined.
 */
export type SweepDeps = SyncForkDeps & {
  repoOverrides: RepoOverrides;
};

export type SyncOne = (
  deps: SyncForkDeps,
  req: SyncRequest,
  state: SyncState,
  cfg: SyncConfig,
  dry?: boolean,
) => Promise<SyncResult>;

export type SweepOptions = {
  only?: string;
  dry: boolean;
  enabled: boolean;
  now: number;
  budget: number;
};

export async function sweepForks(
  deps: SweepDeps,
  syncOne: SyncOne,
  ordered: [string, string, string, string][],
  state: SyncState,
  lines: string[],
  opts: SweepOptions,
): Promise<number> {
  let budget = opts.budget;
  const { dry, only, enabled, now } = opts;

  for (const [token, fork, parent, branch] of ordered) {
    const cfg = syncConfig(fork, deps.repoOverrides, enabled);
    if (!cfg.enabled) continue; // Python line 1750
    if (budget <= 0 && !only) break; // Python lines 1752-1753

    // Python lines 1754-1759: an override pins the branch pair; otherwise
    // the fork's default branch, and upstream's, default to the parent's.
    const meta = await deps.api.request("GET", `/repos/${fork}`, { token });
    const parentMeta =
      meta.data !== null && typeof meta.data === "object" && !Array.isArray(meta.data)
        ? ((meta.data as any).parent ?? {})
        : {};
    const localBranch = cfg.branches?.local || branch;
    const upstreamBranch =
      cfg.branches?.upstream || parentMeta.default_branch || localBranch;

    const info = await upstreamStatus(
      deps.api,
      token,
      fork,
      parent,
      localBranch,
      upstreamBranch,
      { fetchGhToken: deps.fetchGhToken },
    );
    if (!info) {
      lines.push(`🔁 ${fork}: upstream comparison unavailable — will retry`);
      continue; // Python lines 1762-1763
    }
    const [mergeCount, divergence, upstreamSha] = info;
    const entry = syncEntry(state, fork);

    // (1) already in sync — and the stale skip note goes away (1766-1770).
    if (mergeCount <= 0) {
      if (entry.skip_reason) {
        entry.skip_reason = "";
        if (!dry) deps.saveState(state);
      }
      continue;
    }
    // (2) this exact upstream tip was already handled (1771-1772).
    if (entry.last_attempt_sha === upstreamSha) continue;
    // (3) the per-repo interval has not elapsed (1773-1774).
    if (now - num(entry.last_sync_ts) < cfg.interval_h * 3600) continue;

    // (4) an upstream-sync PR is already open for this branch (1775-1778).
    const openPr = await syncOpenPr(deps.api, token, fork, localBranch);
    if (openPr) {
      lines.push(`🔁 ${fork}: upstream-sync PR #${openPr} already open — waiting`);
      continue;
    }

    lines.push(
      `🔁 ${fork}: \`${parent}\` has ${mergeCount} commit(s) the fork lacks ` +
        `(fork divergence ${divergence}) — syncing into ${localBranch}...`,
    );

    const [res, detail] = await syncOne(
      deps,
      {
        fork,
        token,
        parent,
        localBranch,
        upstreamBranch,
        upstreamSha,
        mergeCount,
        divergence,
      },
      state,
      cfg,
      dry,
    );
    await reportOutcome(deps, lines, state, res, detail, {
      fork,
      parent,
      localBranch,
      mergeCount,
      upstreamSha,
      dry,
      // Re-read: the fork flow may have created the entry, and the skip arm
      // below reads `notified` off the SAME object it writes to (Python line
      // 1784 re-reads the entry after the call for exactly this reason).
      entry: syncEntry(state, fork),
    });
    budget -= 1; // Python lines 1795, 1803, 1805, 1809, 1822, 1825
  }

  return budget;
}

/**
 * The Python's if/elif chain over `sync_fork_repo`'s status (lines 1785-1825).
 *
 * Every arm posts to Discord only when not dry. The skip arm is the one with
 * state: it flips `notified` to true and SAVES, so a fork stuck on one upstream
 * tip alerts once and then stays quiet across ticks.
 *
 * `dry` reports two extra statuses with a 🧪 marker and NO side effects, so an
 * operator reading the channel can tell a rehearsal from a real sync.
 */
async function reportOutcome(
  deps: SweepDeps,
  lines: string[],
  state: SyncState,
  res: SyncResult[0],
  detail: string,
  ctx: OutcomeCtx,
): Promise<void> {
  const { fork, parent, localBranch, mergeCount, upstreamSha, dry, entry } = ctx;
  if (res === "synced") {
    lines.push(
      `✅ ${fork}: merged ${mergeCount} commit(s) into \`${localBranch}\`` +
        (detail ? ` — ${detail}` : ""),
    );
    if (!dry) {
      await deps.postDiscord(
        `✅ Fork synced: ${fork}`,
        [
          `${mergeCount} upstream commit(s) merged into \`${localBranch}\``,
          detail ? `— ${detail}` : "",
          `https://github.com/${fork}`,
        ],
        DISCORD_COLOR,
      );
    }
  } else if (res === "pr-opened") {
    lines.push(`🔁 ${fork}: opened ${detail}`);
  } else if (res === "dry") {
    lines.push(`   🧪 dry run (protected): ${detail}`);
  } else if (res === "conflict-failed") {
    lines.push(`   ⏭️  ${detail}`);
    if (!dry && !entry.notified) {
      entry.notified = true;
      deps.saveState(state);
      await deps.postDiscord(
        `⏭️ Fork sync skipped: ${fork}`,
        [
          `❗ ${detail}`,
          `upstream \`${parent}@${upstreamSha.slice(0, 8)}\` — retried when upstream moves or the state file is cleared.`,
          `https://github.com/${fork}`,
        ],
        SKIP_COLOR,
      );
    }
  } else {
    lines.push(`   ⚠️  ${res}: ${detail}`);
  }
}

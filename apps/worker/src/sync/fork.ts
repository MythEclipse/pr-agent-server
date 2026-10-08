/**
 * One fork's sync attempt: clone, merge, resolve, push, or open a PR.
 *
 * Extracted verbatim from `syncForkRepo` in `./run` so that file comes back
 * under the 400-line cap. THIS IS A MOVE, NOT A REWRITE: every git argv, every
 * timeout budget, every truncation width, every report string, and the order
 * they fire in are byte-identical, and the Python (1518-1687) is the reference.
 *
 * THE FUNCTION MOVES WHOLE, NOT IN HALVES. Its second half (Python 1624-1682,
 * from the still-unmerged re-read through the final push) is the larger, more
 * self-contained half, so it is the obvious cut — and it is also the half that
 * holds all six of the early `return ["<status>", detail]` statements. Lifting
 * those into a helper silently re-points every one of them at the HELPER's
 * return instead of `syncForkRepo`'s, so a bare `return ["dry", …]` would stop
 * the wrong function. Moving the whole body keeps each of them returning from
 * `syncForkRepo` itself, which is the only shape that cannot change what a
 * caller observes.
 *
 * `openSyncPr` moved to ./openpr because `syncForkRepo` calls it while `run.ts`
 * imports this module, so leaving it in `run.ts` would have made the pair
 * circular in VALUE terms — the same constraint ./sweep already works around by
 * taking `syncOne` as an argument.
 *
 * THE ORDERING IN `syncForkRepo` IS THE FEATURE, so it is spelled out once here
 * and nowhere repeated: clone → identity → `pre_merge_sha` → fetch upstream
 * `--no-tags <url> <branch>:refs/remotes/upstream/<branch>` → merge → detect
 * unmerged → (agent → SALVAGE → finish-merge) OR (quality pass on a clean
 * merge) → `syncFinishMerge` guards → `pushRef` → protected? → `openSyncPr` →
 * state update → workdir removed in a `finally`.
 *
 * THREE THINGS THAT LOOK LIKE OPTIMISATIONS AND ARE NOT:
 *
 * 1. THE MERGE IS A MERGE, NEVER A REBASE. The fork keeps its local
 *    divergence (Python lines 963-984). `git merge <remote-ref> --no-edit`
 *    with the upstream ref under `refs/remotes/upstream/` is what makes the
 *    merge commit a real two-parent commit the revert path can reason about.
 * 2. THE SALVAGE ORDER IS agent → unmerged check → salvage (lines 1575-1596).
 *    An `ok:false` from the agent does NOT mean failure: resolving N conflicts
 *    legitimately runs past the HTTP timeout (observed: 17 files ≈ 16 min,
 *    128 API calls), so the call can time out AFTER the agent committed. The
 *    salvage is therefore `syncFinishMerge(workdir)` — which re-reads the
 *    ACTUAL unmerged state — and only a refusal there aborts. Checking the
 *    unmerged list BEFORE the agent (i.e. caching the pre-agent list) turns
 *    every recoverable merge into a `conflict-failed`, which is the exact
 *    failure this task exists to prevent.
 * 3. DRY RUNS ARE PURE. `runUpstreamSync` builds a throwaway state and passes
 *    it in; `syncForkRepo` additionally never mutates the state it was given,
 *    never pushes, never opens a PR and never posts to Discord (lines
 *    1527-1531, 1565, 1589, 1602, 1627, 1657, 1788). The workdir is KEPT in dry
 *    mode, because "prepared in <dir>" is the entire point of a dry run.
 *
 * The fourth — the budget and the stalest-first order — describes
 * `runUpstreamSync`, which stayed in ./run, and moved there with it.
 */
import { pushRef } from "../git.ts";
import { head, reportable } from "../pr/lockfix.ts";
import { syncEntry } from "./config.ts";
import type { SyncConfig, SyncState } from "./config.ts";
import { SYNC_TMP_BASE, setSyncIdentity, syncFetchUrl, syncUnmergedFiles } from "./merge.ts";
import { resolveMerge } from "./resolve.ts";
import { openSyncPr } from "./openpr.ts";
import type { SyncForkDeps, SyncRequest, SyncResult } from "./types.ts";

// ── Timeout budgets, one per Python `subprocess.run(..., timeout=N)` ──────────
//
// Only the budgets `syncForkRepo` passes to `run` itself live here. The rest
// moved with their only readers earlier: ABORT / MERGE_DIFF / SNIPPET /
// SHORT_SNIPPET / SALVAGE_SNIPPET to ./resolve, SKIP_COLOR and DISCORD_COLOR to
// ./sweep. There is no duplicate left behind in ./run: the stale copies there
// were checked byte-equal against these and then deleted, so each width and
// budget is now declared exactly once, in the file that reads it.
const CLONE_TIMEOUT_SEC = 300; // 1536
const REV_PARSE_TIMEOUT_SEC = 30; // 1543, 1633
const FETCH_TIMEOUT_SEC = 300; // 1546
const MERGE_TIMEOUT_SEC = 300; // 1553

// ── Truncation widths, one per Python slice ───────────────────────────────────
/** Python `clone failed: {stderr[:200]}` (1540) and the same width at 1551. */
const CLONE_DETAIL = 200;
/** Python `merge error: {(stderr+stdout)[:200]}` (1558). */
const MERGE_ERROR_DETAIL = 200;
/** Python `detail[:200]` on the push-failed paths (1675, 1679). */
const PUSH_DETAIL = 200;
/** Python `detail[:300]` on the final push-failed return (1682). */
const PUSH_REPORT = 300;

const credentialUrl = (token: string, repo: string): string =>
  `https://x-access-token:${token}@github.com/${repo}.git`;

// ── sync_fork_repo ───────────────────────────────────────────────────────────

/**
 * Python `sync_fork_repo(...)` (lines 1518-1687): "One sync attempt for one
 * fork: clone → merge upstream → Claude Code when needed → push (or open a PR
 * when the branch is protected)."
 *
 * NEVER THROWS: the Python's `except Exception` becomes the `try`/`finally`
 * here, and the `finally` removes the workdir on every non-dry path (line
 * 1686-1687) — a leaked clone holds a credentialed `.git/config` and a live
 * `.git/index.lock`.
 *
 * EVERY COMMAND'S OUTPUT PASSES THROUGH `reportable` BEFORE IT REACHES A
 * DETAIL, because a detail is reported to the ops Discord channel (Python
 * lines 1787-1821). The Python inherited a credential leak here (worker fix
 * cc15d06): a push or clone error echoes the URL userinfo.
 */
export async function syncForkRepo(
  deps: SyncForkDeps,
  req: SyncRequest,
  state: SyncState,
  cfg: SyncConfig,
  dry = false,
): Promise<SyncResult> {
  const { run, workdirs, agent } = deps;
  const { fork, token, parent, localBranch, upstreamBranch, upstreamSha } = req;
  const workdir = `${SYNC_TMP_BASE}/${fork.replace(/\//g, "_")}`;

  // Python line 1527: a dry run gets a detached entry and never the real one.
  const entry = dry ? {} : syncEntry(state, fork);

  // DIVERGENCE FROM THE PYTHON, deliberate, and required by the brief.
  //
  // Python lines 1539, 1550 and 1557 call `save_sync_state(state)`
  // UNCONDITIONALLY on the clone / fetch / merge-error exits — no `if dry`.
  // In dry mode `entry` is a throwaway dict, so the entry writes go nowhere,
  // but the SAVE still runs with the caller's `state`, which
  // `run_upstream_sync` sets to `{}` (line 1737). The Python therefore writes
  // `{}` over the real `/tmp/pr-queue-sync-state.json` on a dry run — which
  // silently discards every armed `pending_verify` watch and every
  // `skip_reason`, so the next real tick re-does work and the CI revert
  // guarantee is lost with no trace.
  //
  // Brief group 4 states the requirement directly: "Dry run murni: `state == {}`
  // setelah `syncForkRepo(dry)` (tidak ada tulisan)" — no writes. This guard is
  // that requirement, and it is the only behavioural difference in this file
  // that a caller could observe on a NON-dry path (there is none: every
  // non-dry path still saves, at the same points).
  const persist = () => {
    if (!dry) deps.saveState(state);
  };

  try {
    if (workdirs.exists(workdir)) workdirs.remove(workdir); // Python lines 1532-1533
    workdirs.mkdir(SYNC_TMP_BASE); // Python line 1534 (`workdir.parent`)

    const clone = run(
      ["clone", credentialUrl(token, fork), workdir, "--branch", localBranch],
      undefined,
      CLONE_TIMEOUT_SEC,
    );
    if (clone.code !== 0) {
      entry.last_sync_ts = deps.now(); // Python line 1538
      persist();
      return ["error", `clone failed: ${head(reportable(clone.stderr || "").trim(), CLONE_DETAIL)}`];
    }
    setSyncIdentity(run, workdir); // Python lines 1541-1542
    const preMergeSha = (
      run(["rev-parse", "HEAD"], workdir, REV_PARSE_TIMEOUT_SEC).stdout || ""
    ).trim(); // Python line 1543

    const upstreamRef = `refs/remotes/upstream/${upstreamBranch}`; // Python line 1545
    const fetch = run(
      [
        "fetch",
        "--no-tags",
        syncFetchUrl(parent, deps.fetchGhToken()),
        `${upstreamBranch}:${upstreamRef}`,
      ],
      workdir,
      FETCH_TIMEOUT_SEC,
    );
    if (fetch.code !== 0) {
      entry.last_sync_ts = deps.now(); // Python line 1549
      persist();
      return [
        "error",
        `upstream fetch failed: ${head(reportable(fetch.stderr || "").trim(), CLONE_DETAIL)}`,
      ];
    }

    const merge = run(["merge", upstreamRef, "--no-edit"], workdir, MERGE_TIMEOUT_SEC);
    const conflicted = syncUnmergedFiles(run, workdir); // Python line 1554
    if (merge.code !== 0 && conflicted.length === 0) {
      entry.last_sync_ts = deps.now(); // Python line 1556
      persist();
      const combined = `${merge.stderr || ""}${merge.stdout || ""}`;
      return ["error", `merge error: ${head(reportable(combined).trim(), MERGE_ERROR_DETAIL)}`];
    }

    const outcome = await resolveMerge(run, workdir, conflicted, {
      report: deps.report,
      agent,
      cfg,
      skip: (note: string) => skipNote(deps, entry, state, dry, upstreamSha, note),

      dry,
    }, { fork, parent, upstreamBranch, localBranch, preMergeSha });
    if (outcome.kind === "conflict-failed") return ["conflict-failed", outcome.detail];
    const resolution = outcome.resolution;

    // Python lines 1624-1631. A second unmerged read AFTER the agent, because
    // the agent may have left a path unresolved while the first read (before
    // it ran) was clean. Never push an unresolved merge.
    const stillUnmerged = syncUnmergedFiles(run, workdir);
    if (stillUnmerged.length) {
      return [
        "conflict-failed",
        skipNote(
          deps,
          entry,
          state,
          dry,
          upstreamSha,
          `unmerged paths remain: ${stillUnmerged.slice(0, 5).join(", ")}`,
        ),
      ];
    }

    const mergedSha = (
      run(["rev-parse", "HEAD"], workdir, REV_PARSE_TIMEOUT_SEC).stdout || ""
    ).trim(); // Python line 1633

    if (dry) {
      // Python lines 1634-1636. The workdir is deliberately LEFT IN PLACE: the
      // dry run's whole output is "prepared in <dir>", and a caller that wants
      // to inspect the merge needs the clone to still be there.
      //
      // DIVERGENCE FROM THE PYTHON, and it is a repair. In the Python this
      // `return` sits ABOVE the push (line 1634 vs 1638), so the `if protected:
      // if dry: return "pr-path"` at 1657-1659 is DEAD — a dry run can never
      // reach it, and the `pr-path` arm in the reporter is dead code. The
      // rehearsal therefore cannot tell an operator the one fact it exists to
      // surface: that this branch is protected and a PR would be opened.
      //
      // A REAL PUSH IS NOT THE ANSWER and never will be. Classification is
      // learned from the push's failure only because GitHub's App surface
      // answers 403 on the branch-protection endpoint for many installs — but a
      // dry run must have NO remote effect, so the push is off the table
      // entirely. (`git push --dry-run` is not a way out either: it does not
      // run the remote's pre-receive hook, so it exits 0 on a protected branch
      // and cannot classify. Verified against a local bare repo with a
      // GH006-emitting pre-receive hook — the real push failed, the dry-run
      // push returned 0, and the remote ref was unchanged.)
      //
      // So the classification is a READ-ONLY `GET` on the protection endpoint.
      // 200 → protected → `pr-path`. Anything else (404 no rules, 403 no admin
      // scope) is UNKNOWN, and unknown is reported as the plain `dry`: a false
      // pr-path would send an operator hunting for a PR that would never open.
      const protection = await deps.api.request(
        "GET",
        `/repos/${fork}/branches/${localBranch}/protection`,
        { token },
      );
      if (protection.status === 200) {
        return [
          "pr-path",
          `protected branch detected (${localBranch}) — would open an upstream-sync PR`,
        ];
      }
      return [
        "dry",
        `prepared in ${workdir} — pre_merge ${preMergeSha.slice(0, 8)}, ` +
          `upstream ${upstreamSha.slice(0, 8)}, head ${mergedSha.slice(0, 8)}, ${resolution}`,
      ];
    }

    const pushed = pushRef(workdir, fork, "HEAD", `refs/heads/${localBranch}`, token, false, {
      run,
      pat: deps.fetchGhToken(),
    });

    if (pushed.ok) {
      // Python lines 1641-1654. `pending_verify` is what arms the CI watch, and
      // `pre_merge_sha` is the revert target — both must be recorded BEFORE the
      // save, or a crash between push and save leaves a merge nobody watches.
      entry.last_sync_ts = deps.now();
      entry.last_attempt_sha = upstreamSha;
      entry.last_merged_upstream_sha = upstreamSha;
      entry.skip_reason = "";
      entry.notified = false;
      entry.pending_verify = {
        sha: mergedSha,
        pre_merge_sha: preMergeSha,
        branch: localBranch,
        pushed_at: deps.now(),
      };
      deps.saveState(state);
      return [
        "synced",
        `${req.mergeCount} upstream commit(s) merged into ${localBranch} ` +
          `(${resolution}); head ${mergedSha.slice(0, 8)}; ${pushed.detail}`,
      ];
    }

    if (pushed.protected) {
      // Python lines 1656-1667: the App gets 403 (not 404) on the
      // branch-protection endpoint, so "protected" is learned FROM THE PUSH —
      // which is why this branch exists at all.
      const prNum = await openSyncPr(
        run,
        deps.api,
        token,
        workdir,
        fork,
        parent,
        localBranch,
        upstreamBranch,
        upstreamSha,
        req.mergeCount,
        req.divergence,
        resolution,
        { now: deps.now, fetchGhToken: deps.fetchGhToken },
      );
      if (prNum) {
        // A PR-path sync merged NOTHING into the branch, so no CI watch is
        // armed and the merged sha is cleared — otherwise `verifyPendingSyncs`
        // would be watching a commit that does not exist.
        entry.last_sync_ts = deps.now();
        entry.last_attempt_sha = upstreamSha;
        entry.last_merged_upstream_sha = "";
        entry.skip_reason = "";
        entry.notified = false;
        deps.saveState(state);
        return [
          "pr-opened",
          `${localBranch} is protected — opened PR #${prNum} ` +
            `(${req.mergeCount} upstream commit(s), ${resolution})`,
        ];
      }
      entry.last_sync_ts = deps.now();
      persist();
      return [
        "push-failed",
        `protected branch and PR creation failed: ${head(pushed.detail, PUSH_DETAIL)}`,
      ];
    }

    entry.last_sync_ts = deps.now(); // Python lines 1677-1681
    entry.last_attempt_sha = upstreamSha;
    entry.skip_reason = head(pushed.detail, PUSH_DETAIL);
    entry.notified = false;
    deps.saveState(state);
    return ["push-failed", head(pushed.detail, PUSH_REPORT)];
  } catch (err) {
    // Python lines 1683-1684: "a sync must never take the whole tick down".
    return ["error", `${err instanceof Error ? err.name : typeof err}: ${err instanceof Error ? err.message : String(err)}`];
  } finally {
    if (!dry) workdirs.remove(workdir); // Python lines 1686-1687
  }
}

/**
 * Record a skip and return its note. The Python repeats this five-line block at
 * five call sites (lines 1565-1568, 1589-1592, 1600-1603, 1627-1630), and each
 * repetition is the whole "skip ONCE per upstream tip" contract: `last_sync_ts`
 * moves, `last_attempt_sha` names the tip so `run_upstream_sync` will not retry
 * it, and `notified: false` lets the caller post a single Discord alert.
 */
function skipNote(
  deps: SyncForkDeps,
  entry: Record<string, unknown>,
  state: SyncState,
  dry: boolean,
  upstreamSha: string,
  note: string,
): string {
  if (dry) return note;
  entry.last_sync_ts = deps.now();
  entry.last_attempt_sha = upstreamSha;
  entry.skip_reason = note;
  entry.notified = false;
  deps.saveState(state);
  return note;
}

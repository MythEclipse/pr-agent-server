/**
 * The terminal gates and the shared conflict resolver — extracted verbatim from
 * `./pipeline` for the 400-line cap. THIS IS A MOVE, NOT A REWRITE.
 *
 * `resolveConflict` is the one block the Python wrote TWICE (2071-2105 and
 * 2134-2161), byte-identical except for the report line and whether the head is
 * re-fetched, so it is one function here with those two differences as
 * parameters. It is exported because its two call sites are in different files:
 * `stepMerge` below, and `processPr` in `./pipeline`.
 *
 * `stepSafetyAndCi` and `stepMerge` are here because every one of their arms
 * ENDS the PR's turn — the safety block's `score` is carried out through `Ctx`
 * and the two dry-run arms are the ones that report what they would have done.
 * The stale-dependabot age arithmetic (Python 2051) is `ageDays` in `./context`.
 */
import { checkPrStillValid, killOrphanedAgent, runAiFix } from "./autofix";
import { STALE_CI_CLOSE_DAYS, checkCiPassed, closeStaleCiPr } from "./ci";
import { approvePr, mergePr } from "./merge";
import { analyzeReviewSafety } from "./safety";
import {
  AI_FIX_ENABLED,
  UNRESOLVABLE_CONFLICT,
  ageDays,
  isInfra,
  movedSha,
  persist,
  refetchHead,
  reportSkipNotice,
  stripInfra,
  subDeps,
  type Ctx,
  type WorkerDeps,
} from "./context";
import { markFixed, markSkip } from "../state";


// ── The conflict resolver, used from TWO sites (2071-2105 and 2134-2161) ────

/**
 * The "resolve this conflict with the agent, once per head SHA" block. The
 * Python writes it twice, byte-identical except for the report line and for
 * whether the head is re-fetched, so it is one function here with those two
 * differences as parameters: `recheck` is the 2066 site, and the 409 site does
 * NOT re-fetch.
 *
 * Always ends the PR's turn — success, failure and give-up all `continue` — so
 * it returns nothing and the caller counts the outcomes.
 */
export async function resolveConflict(
  deps: WorkerDeps,
  c: Ctx,
  already: boolean,
  onFixed: string,
  recheck: boolean,
): Promise<void> {
  const giveUp = recheck
    ? "   ⏭️  Skipping (conflict, already attempted at this SHA)"
    : "   ⏭️  Skipping (409 conflict, already attempted)";
  if (AI_FIX_ENABLED && !already) {
    if (deps.dry) {
      deps.report.push("   🧪 dry run: would ask the agent to resolve the merge conflict");
      return;
    }
    const [valid] = await checkPrStillValid(deps.api, c.token, c.repo, c.prNum, c.headSha);
    if (valid) {
      deps.report.push("   🤖 Resolving merge conflict with Claude Code...");
      killOrphanedAgent(deps.procs, c.repo, c.prNum);
      const { ok, summary } = await runAiFix(
        subDeps(deps), c.repo, c.prNum, c.title, c.headSha, c.headRef, c.baseRef, c.token,
      );
      if (ok) {
        deps.report.push(`   ✨ Conflict resolved: ${summary}`);
        markFixed(c.fixState, c.repo, c.prNum, c.headSha);
        persist(deps, c.fixState);
        c.out.fixed = true;
        if (recheck) {
          const sha = movedSha(await refetchHead(deps, c), c.headSha);
          if (sha) deps.report.push(onFixed);
        } else {
          deps.report.push(onFixed);
        }
        return;
      }
      deps.report.push(`   ⏭️  Conflict fix failed: ${summary}`);
      const why = isInfra(summary) ? stripInfra(summary) : UNRESOLVABLE_CONFLICT;
      markSkip(c.fixState, c.repo, c.prNum, c.headSha, why);
      persist(deps, c.fixState);
      await reportSkipNotice(deps, c, why);
      return;
    }
  }
  deps.report.push(giveUp);
}

// ── STEP C/D — safety + CI gate (2031-2064) ─────────────────────────────────

/** True when the PR stops here. */
export async function stepSafetyAndCi(deps: WorkerDeps, c: Ctx, review: string): Promise<boolean> {
  const safety = analyzeReviewSafety(review);
  for (const reason of safety.reasons) deps.report.push(`   ${reason}`);
  if (!safety.safe) {
    deps.report.push(`   🔴 SAFETY BLOCKED (score: ${safety.score}/10)`);
    c.out.skipped = true;
    return true;
  }
  deps.report.push(`   ✅ Safety score: ${safety.score}/10`);
  c.score = safety.score;

  const ci = await checkCiPassed(deps.api, c.token, c.repo, c.headSha);
  deps.report.push(`   🧪 CI: ${ci.msg}`);
  // An unreadable gate is not a green one, and it must stop BEFORE the stale
  // branch below — otherwise "we do not know" gets answered with a close.
  if (ci.unknown) {
    deps.report.push("   ⏳ CI unknown — not merging on an unverified gate; will retry next tick");
    c.out.skipped = true;
    return true;
  }
  if (ci.ok) return false;

  // A dependabot bump stuck on red CI for days will never pass (it is
  // incompatible with the stack), so it is CLOSED — otherwise the worker prints
  // "Waiting for green CI" on the same PR forever (2046-2064).
  if (c.author === "dependabot[bot]") {
    const age = ageDays(c.createdAt, deps.now());
    if (age > STALE_CI_CLOSE_DAYS) {
      deps.report.push(`   ⛔ CI failing for ${age.toFixed(1)}d — closing stale dependabot PR`);
      if (deps.dry) {
        deps.report.push(`   🧪 dry run: would close #${c.prNum} (stale failing CI)`);
        c.out.skipped = true;
        return true;
      }
      const { status } = await closeStaleCiPr(deps.api, c.token, c.repo, c.prNum, c.title, ci.msg);
      if (status === 200) {
        deps.report.push(`   ✅ Closed #${c.prNum} (stale failing CI)`);
        c.out.skipped = true;
        return true; // Python 2060: `continue` on a 200, else fall through.
      }
      deps.report.push(`   ⚠️  Close failed HTTP ${status}`);
    }
  }
  deps.report.push("   ⏳ Waiting for green CI");
  c.out.skipped = true;
  return true;
}

// ── STEP E — approve + merge (2110-2170) ────────────────────────────────────

/**
 * The cause of a RETRYABLE merge failure — GitHub's own 5xx, or no answer at
 * all (`0`) — or `null` when the answer is a refusal the next tick cannot fix.
 */
const transientMergeCause = (status: number): string | null => {
  if (status === 0) return "no response from GitHub";
  return status >= 500 ? `GitHub HTTP ${status}` : null;
};

/** True when the PR merged. */
export async function stepMerge(deps: WorkerDeps, c: Ctx, already: boolean): Promise<boolean> {
  const url = `https://github.com/${c.repo}/pull/${c.prNum}`;

  deps.report.push("   👍 Approving...");
  if (deps.dry) {
    deps.report.push(`   🧪 dry run: would approve and merge #${c.prNum}`);
    return false;
  }
  const approveStatus = await approvePr(deps.api, c.token, c.repo, c.prNum);
  deps.report.push(
    approveStatus === 200 || approveStatus === 201
      ? "   ✅ Approved!"
      : `   ⚠️  Approve: HTTP ${approveStatus}`,
  );

  deps.report.push("   🔀 Merging...");
  const { status, data } = await mergePr(
    { fetchGhToken: deps.fetchGhToken }, deps.api, c.token, c.repo, c.prNum, c.headSha,
  );
  if (status === 200) {
    deps.report.push(`   ✅ MERGED! SHA: ${data?.sha ?? "?"}`);
    await deps.notify(c.repo, c.prNum, "done", `PR merged (${c.title})`, c.score, url);
    return true;
  }
  if (status === 405) {
    deps.report.push("   ⚠️  Branch protection blocks merge");
    return false;
  }
  if (status === 409) {
    // GitHub said mergeable and then refused — a stale `mergeable` read. Same
    // one-attempt resolve as the 2066 gate, and equally not retried.
    deps.report.push("   ⚠️  Merge conflict");
    await resolveConflict(deps, c, already, "   🔄 Will re-merge next tick after CI settles", false);
    return false;
  }
  // An outage is not a refusal: the next tick retries it, so calling this a
  // failed review — what GitHub's 2026-10-07 incident produced four times over —
  // would tell the operator that work was rejected when nothing was decided.
  const cause = transientMergeCause(status);
  if (cause) {
    deps.report.push(`   ⚠️  Merge deferred: ${cause} — will retry next tick`);
    await deps.notify(
      c.repo,
      c.prNum,
      "retry",
      `Merge deferred: ${cause} (transient) — will retry next tick`,
      c.score,
      url,
    );
    return false;
  }
  deps.report.push(`   ⚠️  Merge: HTTP ${status}`);
  await deps.notify(c.repo, c.prNum, "failed", `Merge failed HTTP ${status}: ${data?.message ?? ""}`, c.score, url);
  return false;
}

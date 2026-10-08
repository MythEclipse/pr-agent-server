/**
 * STEPS A0 / A / A2 / B — the walk from "a PR arrived" to "the AI fix has run or
 * declined to", extracted verbatim from `./pipeline` for the 400-line cap. THIS
 * IS A MOVE, NOT A REWRITE.
 *
 * The ORDER here is the product and it is unchanged: the pin guard runs BEFORE
 * the review and its end-of-turn is unconditional (Python 1885/1899), a
 * triggered review is NOT a skip (1934), and the trivial-PR lockfile pre-fix
 * (1953-1986) runs before the agent. Every report string, the emoji, the two
 * spaces after `⏭️`/`⚠️` and the 3-space indent are the Python's.
 *
 * The three-way bun/uv arm in `stepLockPrefix` keeps its explanatory comment
 * because it is the load-bearing part of that function, not decoration.
 */

import { markFixed, markSkip } from "../state.ts"
import { checkPrStillValid, killOrphanedAgent, runAiFix } from "./autofix.ts"
import { checkCiPassed } from "./ci.ts"
import {
	AI_FIX_ENABLED,
	type Ctx,
	isInfra,
	movedSha,
	NO_CODE_REVIEW,
	persist,
	refetchHead,
	reportSkipNotice,
	stripInfra,
	subDeps,
	type WorkerDeps,
} from "./context.ts"
import { fixBunLock, fixUvLock, isTrivialPr, repoHasBunLock } from "./lockfix.ts"
import { closeToolchainPr, TOOLCHAIN_PINS, toolchainPinViolation } from "./pins.ts"
import { findReviewComment, findTrivialNoReviewMarker, triggerReview } from "./review.ts"

// ── STEP A0 — toolchain pin guard (1882-1899) ───────────────────────────────

/** True when the PR's turn is over. Closes dependabot bumps of a pinned major. */
export async function stepPinGuard(deps: WorkerDeps, c: Ctx): Promise<boolean> {
	if (c.author !== "dependabot[bot]") return false
	const violation = toolchainPinViolation(c.repo, c.title)
	if (!violation) return false
	const [pkg, oldVer, newVer] = violation

	deps.report.push(
		`   ⛔ Toolchain pin violation: ${pkg} ${oldVer} → ${newVer} (allowed major ${TOOLCHAIN_PINS[c.repo][pkg]})`,
	)
	if (deps.dry) {
		deps.report.push(`   🧪 dry run: would close #${c.prNum} (pin violation)`)
		c.out.skipped = true
		return true
	}
	const { status } = await closeToolchainPr(deps.api, c.token, c.repo, c.prNum, pkg, oldVer, newVer)
	if (status === 200) {
		deps.report.push(`   ✅ Closed #${c.prNum} (pin violation)`)
		c.out.skipped = true // Python counts a skip ONLY on a 200 close.
	} else {
		deps.report.push(`   ⚠️  Close failed HTTP ${status} — leaving open`)
	}
	return true
}

// ── STEP A — review (1901-1936) ─────────────────────────────────────────────

/**
 * Returns the review body, or null when the PR STOPS for this tick — a review
 * was just triggered and needs a cycle.
 */
export async function stepReview(deps: WorkerDeps, c: Ctx): Promise<string | null> {
	const found = await findReviewComment(deps.api, c.token, c.repo, c.prNum)
	if (found) {
		deps.report.push("   📝 Review found")
		return found
	}
	// The trivial-PR branch (1912-1923) is a fix, not an optimisation: a
	// lockfile-only bump yields "No code suggestions found" rather than a guide,
	// and re-triggering every five minutes produced duplicate comment spam.
	if (
		isTrivialPr(c.title, c.author) &&
		(await findTrivialNoReviewMarker(deps.api, c.token, c.repo, c.prNum))
	) {
		deps.report.push(
			"   📝 PR-Agent assessed (no-code/lockfile PR) — no code to review, treating as reviewed",
		)
		c.noCodeReview = true
		return NO_CODE_REVIEW
	}
	deps.report.push("   📡 No review → triggering PR-Agent...")
	const result = await triggerReview(
		{
			api: deps.api,
			fetchImpl: deps.fetchImpl,
			webhookSecret: deps.webhookSecret,
			webhookUrl: deps.webhookUrl,
		},
		c.repo,
		c.prNum,
		c.title,
		c.headSha,
		c.headRef,
		c.baseRef,
	)
	if (typeof result === "number" && result >= 200 && result < 300) {
		deps.report.push(`   ✅ PR-Agent triggered (HTTP ${result})`)
		c.out.triggered = true
	} else {
		deps.report.push(`   ⚠️  Trigger result: ${result}`)
	}
	return null
}

// ── STEP A2 — lockfile pre-fix for trivial PRs (1953-1986) ─────────────────

/**
 * For a lockfile-only PR whose CI is red on a lockfile check, re-resolve and
 * push the lockfile BEFORE the AI agent runs. `bun.lock` first for a Bun repo;
 * `uv.lock` is the fallback, SKIPPED when the CI message already names it
 * (1973) — re-resolving the file uv just complained about costs a clone and
 * changes nothing.
 */
export async function stepLockPrefix(deps: WorkerDeps, c: Ctx): Promise<void> {
	const early = await checkCiPassed(deps.api, c.token, c.repo, c.headSha)
	if (early.ok || !early.msg.includes("typecheck")) return
	// Python 1961-1973 is a THREE-way, not a two-way with a default:
	//   if has_bun:                    -> fix_bun_lock
	//   elif "uv.lock" not in ci_msg:  -> fix_uv_lock
	//   (else)                         -> fall through, change nothing
	//
	// The third arm is the load-bearing one: a CI message that already names
	// uv.lock is complaining about the file uv would re-resolve, so re-resolving
	// costs a clone, changes nothing, and in a non-Bun repo the naive two-way
	// rewrite ends up PUSHING a regenerated bun.lock the repo does not use, on a
	// PR the Python left untouched. It cannot be a disjunction at all: `has_bun`
	// alone must select bun (a Bun repo is unaffected by what CI names), and the
	// negative guard belongs on the uv arm only.
	const hasBun = await repoHasBunLock(deps.api, c.token, c.repo, c.headSha)
	const uvBlocked = early.msg.includes("uv.lock")
	if (!hasBun && uvBlocked) return // Python 1973's implicit else.
	const useBun = hasBun

	deps.report.push(
		useBun
			? "   🔧 CI failing: bun.lock stale — pre-fixing..."
			: "   🔧 CI failing: uv.lock stale — pre-fixing...",
	)
	if (deps.dry) {
		deps.report.push("   🧪 dry run: would re-resolve and push the lockfile")
		return
	}
	const { ok, summary } = useBun
		? await fixBunLock(subDeps(deps), c.repo, c.prNum, c.headRef, c.baseRef)
		: await fixUvLock(subDeps(deps), c.repo, c.prNum, c.headRef, c.baseRef)
	if (!ok) return // Python 1965: a failed fix reports nothing and moves on.

	deps.report.push(`   ✅ ${summary}`)
	const sha = movedSha(await refetchHead(deps, c), c.headSha)
	if (sha) {
		deps.report.push("   🔄 Head SHA updated")
		c.headSha = sha
	}
}

// ── STEP B — AI fix (1951-2029) ─────────────────────────────────────────────

/**
 * Runs the agent on the PR branch, or skips because this SHA was handled
 * already. `check_pr_still_valid` runs FIRST (1993) so a PR closed under us is
 * not paid for, and its NEW head is adopted (1998-2000) so the merge path
 * re-reads reality instead of a stale sha.
 */
export async function stepAiFix(deps: WorkerDeps, c: Ctx, already: boolean): Promise<void> {
	if (!AI_FIX_ENABLED || c.noCodeReview) return
	// Python line 1956: `is_trivial_pr(title, author) and not already`.
	if (isTrivialPr(c.title, c.author) && !already) await stepLockPrefix(deps, c)

	if (already) {
		deps.report.push("   ⏭️  Already fixed at this SHA — skip AI fix")
		return
	}
	if (deps.dry) {
		deps.report.push("   🧪 dry run: would run the Hermes AI fix")
		return
	}
	const [valid, newSha, newMergeable, reason] = await checkPrStillValid(
		deps.api,
		c.token,
		c.repo,
		c.prNum,
		c.headSha,
	)
	if (!valid) {
		deps.report.push(`   ⏭️  PR changed: ${reason}`)
		if (newSha) {
			c.headSha = newSha
			c.mergeable = typeof newMergeable === "boolean" ? newMergeable : null
		}
		return
	}

	killOrphanedAgent(deps.procs, c.repo, c.prNum)
	const { ok, summary } = await runAiFix(
		subDeps(deps),
		c.repo,
		c.prNum,
		c.title,
		c.headSha,
		c.headRef,
		c.baseRef,
		c.token,
	)
	if (ok) {
		deps.report.push(`   ✨ ${summary}`)
		markFixed(c.fixState, c.repo, c.prNum, c.headSha)
		persist(deps, c.fixState)
		c.out.fixed = true
		const fresh = await refetchHead(deps, c)
		const sha = movedSha(fresh, c.headSha)
		if (sha) {
			deps.report.push("   🔄 Head SHA updated for merge")
			c.headSha = sha
			c.mergeable = typeof fresh?.mergeable === "boolean" ? fresh.mergeable : null
		}
		return
	}

	deps.report.push(`   ⏭️  AI fix skipped: ${summary}`)
	if (isInfra(summary)) {
		// Infra-level failure (CLI missing / timeout / unreachable): permanently
		// skip at this SHA, or retrying every 5 min would just loop (2023-2025).
		const why = stripInfra(summary)
		markSkip(c.fixState, c.repo, c.prNum, c.headSha, why)
		persist(deps, c.fixState)
		await reportSkipNotice(deps, c, why)
	}
}

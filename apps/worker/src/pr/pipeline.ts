/**
 * Per-PR decision pipeline + tick runner — port of `scripts/pr-queue-worker.py`
 * lines 1833-2186 (`main`), plus `notify_skip_once` (485-495) and the no-code
 * review body (1915-1923). This file is now ONLY the orchestrator: the step
 * bodies, the conflict resolver and the shared vocabulary moved to siblings.
 *
 *   ./context — `Ctx`, the flat `WorkerDeps` injection surface, the constants
 *               and every small helper (`notifySkipOnce`, `refetchHead`, …).
 *   ./steps   — STEP A0 (pin guard), A (review), A2 (lockfile pre-fix),
 *               B (AI fix). Runs before any gate.
 *   ./gates   — the conflict resolver, STEP C/D (safety + CI) and STEP E
 *               (approve + merge). Every arm ends the PR's turn.
 *
 * THE ORDER IS THE PRODUCT. A PR walks exactly one path: pin guard →
 * review/trigger → permanent skip → AI fix → safety → CI → mergeable →
 * approve+merge, and each gate ends the PR's turn. The pin guard is BEFORE the
 * review (1885) and its `continue` is UNCONDITIONAL (1899), so a failed close
 * abandons the PR without counting it skipped. A TRIGGERED review is NOT a skip
 * (1934). The wiring below is the Python's order, unchanged.
 *
 * EVERY REPORT STRING IS A LITERAL. They land on a Discord channel an operator
 * reads, and several are contracts (the `[INFRA]` prefix, `⏭️  Permanently
 * skipped:`, `Unresolvable merge conflict`). The emoji, the two spaces after
 * `⏭️`/`⚠️` and the 3-space indent are the Python's.
 *
 * `deps` is ONE flat object and is the UNION of the ported modules' own deps
 * (`AiFixDeps`, `LockfixDeps`, `MergeDeps`, `RunUpstreamSyncDeps`), not a
 * parallel abstraction. Every global the Python reached for is a field, which
 * is what makes a whole tick testable without a socket.
 *
 * `runTick` is deliberately NOT responsible for `bootstrapEnv()`: the Python
 * did that at import time, before its config constants resolved, and
 * `src/index.ts` is where it has to happen (see env.ts's call-order note).
 *
 * The re-exports below keep this module's public surface exactly what it was
 * before the split — `index.ts` and the tests import from here, and neither
 * should have to learn that the steps moved.
 */

import { LOCK_FILE } from "../lock.ts"
import {
	alreadyFixed,
	attemptCount,
	getSkipReason,
	pruneClosedFixState,
	shouldRetryAiFix,
} from "../state.ts"
import { runUpstreamSync } from "../sync/run.ts"
import type { ReportPort } from "./autofix.ts"
import {
	AI_FIX_ENABLED,
	AI_FIX_RETRY_CEILING,
	type Ctx,
	ctime,
	notifySkipOnce,
	type PrResult,
	strOf,
	titleOf,
	type WorkerDeps,
} from "./context.ts"
import { resolveConflict, stepMerge, stepSafetyAndCi } from "./gates.ts"
import { gatherOpenPrs, type OpenPr } from "./scan.ts"
import { stepAiFix, stepPinGuard, stepReview } from "./steps.ts"

export {
	ctime,
	type LockPort,
	type Notify,
	type PrResult,
	UNRESOLVABLE_CONFLICT,
	type WorkerDeps,
} from "./context.ts"

/** Python's four counters (1859-1862), summed across the tick's PRs. */
export type PrCounts = { merged: number; triggered: number; fixed: number; skipped: number }

/** The four counter keys, for the tick's accumulate loop. */
const COUNTERS: (keyof PrCounts)[] = ["merged", "triggered", "fixed", "skipped"]

// ── process_pr ──────────────────────────────────────────────────────────────

/**
 * One PR, start to finish, in the Python's order. Every human-readable line
 * reaches `deps.report` by the time this returns — the Python's BUFFER
 * discipline — and the four booleans say which counters that PR moved.
 *
 * `already` is read ONCE (1940) and threaded to both resolve sites: the Python
 * reuses that one local, so a fix already recorded must not buy a second agent
 * run at this SHA.
 */
export async function processPr(deps: WorkerDeps, open: OpenPr): Promise<PrResult> {
	const { token, repo, pr } = open
	const c: Ctx = {
		token,
		repo,
		prNum: pr?.number,
		title: titleOf(pr),
		headSha: strOf(pr?.head?.sha),
		headRef: strOf(pr?.head?.ref),
		baseRef: strOf(pr?.base?.ref),
		author: strOf(pr?.user?.login),
		mergeable: typeof pr?.mergeable === "boolean" ? pr.mergeable : null,
		createdAt: pr?.created_at,
		fixState: deps.loadFixState(),
		noCodeReview: false,
		score: "",
		out: { merged: false, triggered: false, fixed: false, skipped: false },
	}

	deps.report.push(`\n${"─".repeat(40)}`)
	deps.report.push(`🔀 ${repo} #${c.prNum} — ${c.title}`)
	deps.report.push(`   👤 ${c.author} | branch: ${c.headRef} → ${c.baseRef}`)

	if (pr?.merged || pr?.state !== "open") {
		deps.report.push("   ⏭️  Already merged/closed")
		c.out.skipped = true // Python lines 1877-1879
		return c.out
	}
	if (await stepPinGuard(deps, c)) return c.out

	const review = await stepReview(deps, c)
	if (review === null) return c.out // Triggered review: NOT a skip (line 1934).

	let already = alreadyFixed(c.fixState, repo, c.prNum, c.headSha)
	// The recorded "fixed" may have been "the agent found nothing to improve",
	// which says nothing about whether the PR can merge. mcpedia#28 sat on
	// `⏭️  Already fixed at this SHA` for 97 ticks while CI was red, because a
	// vitest dev-dep bump has nothing for the agent to improve — and the blocker
	// was CI config, which it never looks at. Re-offer the agent when, and only
	// when, the recorded run produced no commit on a dependabot bump.
	if (shouldRetryAiFix(c.fixState, repo, c.prNum, c.headSha, c.author)) {
		// Re-offering is only safe with a bound, because the agent costs up to
		// 1800s per run. `AI_FIX_RETRY_CEILING` is deliberately NOT a skip: past
		// it the PR goes back to being counted as an ordinary red-CI wait, which
		// is honest ("we tried, it did not help") and still lets the stale-close
		// arm retire a dependabot bump that never turns green.
		if (attemptCount(c.fixState, repo, c.prNum, c.headSha) >= AI_FIX_RETRY_CEILING) {
			deps.report.push(
				`   ⏭️  AI fix already re-offered ${AI_FIX_RETRY_CEILING}× at this SHA with no commit — leaving it to the CI gate`,
			)
		} else {
			already = false
			deps.report.push(
				"   ♻️  Previous run produced no commit — offering the AI fix again (recorded 'fixed' did not unblock this PR)",
			)
		}
	}
	const skipReason = getSkipReason(c.fixState, repo, c.prNum, c.headSha)
	if (skipReason) {
		// Respect the recorded reason until the head changes; re-running every cron
		// tick is exactly what the skip exists to prevent (1942-1949).
		deps.report.push(`   ⏭️  Permanently skipped: ${skipReason} (until head SHA changes)`)
		// Python line 1947 calls `notify_skip_once(...)` as a BARE statement — the
		// notification fires, but no `🔔 Skip notified` line is appended. Only the
		// three `if notify_skip_once(...):` sites (2028, 2102, 2158) report it, so
		// routing this through `reportSkipNotice` would put a line in the ops
		// channel on every tick of every permanently-skipped PR. This is the single
		// site in the port that must notify silently.
		await notifySkipOnce(deps, c, skipReason)
		c.out.skipped = true
		return c.out
	}

	await stepAiFix(deps, c, already)
	if (await stepSafetyAndCi(deps, c, review)) return c.out

	// `=== false`, NOT falsy: GitHub's `mergeable` is null while it computes, and
	// the Python treats that as "not a conflict" (line 2066).
	if (c.mergeable === false) {
		deps.report.push("   🔴 Merge conflicts")
		await resolveConflict(deps, c, already, "   🔄 Head SHA updated (conflict fix pushed)", true)
		c.out.skipped = true
		return c.out
	}
	c.out.merged = await stepMerge(deps, c, already)
	// Python: every non-merged arm falls into skipped_count.
	if (!c.out.merged) c.out.skipped = true
	return c.out
}

// ── run_tick ────────────────────────────────────────────────────────────────

/**
 * One cron tick: lock → upstream sync → PR fan-out → summary → flush, with the
 * lock released on every exit including a throw.
 *
 * THE TWO SILENT EXITS ARE SILENT ON PURPOSE. A lost lock (1837) and a tick with
 * nothing to do and nothing to sync (1847) both return before a single BUFFER
 * line: the report is Discord-posted on a non-TTY, and an empty tick posting
 * "0 PRs" every five minutes is how a channel stops being read.
 *
 * The Python's BUFFER is one global that the sync, the AI fix and the summary
 * all append to in that order. The collector here is the same object for all
 * three, so the interleaving survives — and it also returns the lines, which is
 * what the brief's `Promise<string[]>` promises.
 */
export async function runTick(deps: WorkerDeps): Promise<string[]> {
	const lines: string[] = []
	const start = deps.now()
	// Set by the workdir sweep below and reported on both the normal and the
	// empty-queue return path. Declared here because the sweep runs before the
	// report header is built.
	let sweepNotice = ""

	const lock = deps.lock.acquire(LOCK_FILE)
	if (!lock) return lines // Python lines 1837-1838
	deps.onLockAcquired?.(() => lock.release())

	const report: ReportPort = {
		push: (line: string) => {
			lines.push(line)
			deps.report.push(line)
		},
	}
	const tick: WorkerDeps = { ...deps, report }

	try {
		const syncLines = await runUpstreamSync(
			{
				run: deps.run,
				workdirs: deps.workdirs,
				agent: deps.agent,
				api: deps.api,
				fetchGhToken: deps.fetchGhToken,
				postDiscord: deps.postDiscord,
				loadState: deps.loadSyncState,
				saveState: deps.saveSyncState,
				now: deps.now,
				report,
				repoOverrides: deps.repoOverrides,
			},
			{ dry: deps.dry },
		)
		const allPrs = await gatherOpenPrs(deps.api)
		// Sweep BEFORE the empty-queue early return. The sweep used to sit after
		// it, which meant it never ran in the one state that matters most: with
		// zero open PRs the whole queue is stale, and that is exactly when the
		// early return fired. Measured on 2026-10-17 — 0 open PRs across every
		// repo, 56 stale workdirs, and no sweep line in the report.
		//
		// Safe to run unconditionally because `sweepStaleWorkdirs` requires BOTH
		// that the PR be absent from the open set AND that the directory be older
		// than `SWEEP_MIN_AGE_HOURS`. A failed or partial scan can therefore only
		// remove directories that are already old; a live clone is never old,
		// because a tick reuses and re-fetches it. The two conditions agreeing is
		// what makes this correct under a bad scan, and it is why the age floor is
		// not just a nicety.
		//
		// NOT a `skip_reason` and NOT left to chance: this is the same leak that
		// filled a 7.8G tmpfs and broke an unrelated service's deploy.
		if (!deps.dry) {
			const openKeys = new Set(
				allPrs.map((o) => `${o.repo}/${o.pr?.number}`).filter((k) => !k.endsWith("undefined")),
			)
			const swept = deps.workdirs.sweepStale?.(openKeys) ?? 0
			if (swept > 0) {
				// Reported before the header so the count lands even on the
				// empty-queue return path below.
				sweepNotice = `   🧹 Swept ${swept} stale clone workdir(s) for closed PRs`
			}
		}
		if (!allPrs.length && !syncLines.length) {
			if (sweepNotice) lines.push(sweepNotice)
			return lines // Python lines 1847-1848
		}

		report.push(`🔍 PR Queue Worker — ${ctime(start)}`)
		report.push("=".repeat(50))
		if (sweepNotice) report.push(sweepNotice)
		for (const line of syncLines) report.push(line) // Python lines 1852-1853
		if (allPrs.length) {
			report.push(`📋 Found ${allPrs.length} open PR(s) to process`)
			if (AI_FIX_ENABLED) report.push("   ✨ AI auto-fix: ENABLED (Claude Code)")
		}

		const counts: PrCounts = { merged: 0, triggered: 0, fixed: 0, skipped: 0 }
		for (const open of allPrs) {
			const r = await processPr(tick, open)
			for (const k of COUNTERS) if (r[k]) counts[k] += 1
		}

		// Prune AFTER the PRs are processed, so this tick's own entries survive
		// even if a PR is merged in the loop above. `allPrs` is the freshly
		// gathered open set, which is exactly the authority the prune needs — and
		// the reason it is safe: it ran against a real, non-empty scan rather than
		// an assumed one.
		if (!deps.dry) {
			const fixState = deps.loadFixState()
			const openKeys = new Set(
				allPrs.map((o) => `${o.repo}/${o.pr?.number}`).filter((k) => !k.endsWith("undefined")),
			)
			const removed = pruneClosedFixState(fixState, openKeys)
			if (removed > 0) {
				deps.saveFixState(fixState)
				report.push(`   🧹 Pruned ${removed} fix-state entr(ies) for closed/merged PRs`)
			}
			// Sweep the clone workdirs for those same closed PRs. The state prune
			// above has always had a sibling missing: `/tmp/pr-queue-work` was
			// cleaned ONLY on an error path, because the clone is deliberately
			// REUSED across ticks (see the reuse comment in `autofix.ts`), so it
			// accumulated one directory per PR ever touched and nothing removed
			// the ones whose PR had long since closed. On 2026-10-17 that reached
			// 56 dirs / 1.8G on a 7.8G tmpfs and filled it, failing an unrelated
			// service's deploy with `No space left on device` — the tar staged
			// its payload in /tmp.
			//
			// Safe by the same two rules as the state prune: it runs against a
			// real non-empty scan, and it only removes workdirs whose PR is NOT
			// open. A wrong open-PR set can therefore leave a workdir behind, but
			// can never delete one that is in use. The skip threshold is reused
			// rather than re-invented so a transiently empty scan cannot wipe
			// every clone at once — re-cloning is cheap but not free, and the
			// agent would lose a reused worktree mid-convergence.
			const swept = deps.workdirs.sweepStale?.(openKeys) ?? 0
			if (swept > 0) {
				report.push(`   🧹 Swept ${swept} stale clone workdir(s) for closed PRs`)
			}
		}

		report.push(`\n${"=".repeat(50)}`)
		report.push(`📊 Summary (${(deps.now() - start).toFixed(1)}s)`) // Python line 2175
		if (AI_FIX_ENABLED) report.push(`   ✨ AI fixes applied: ${counts.fixed}`)
		report.push(`   ✅ Merged: ${counts.merged}`)
		report.push(`   📡 Reviews triggered: ${counts.triggered}`)
		report.push(`   ⏭️  Skipped: ${counts.skipped}`)
		report.push("=".repeat(50))

		// `flush_log` (2183). On a non-TTY the flush posts to the ops channel, which
		// is one of the four effects `--dry` suppresses, so a rehearsal stays local.
		if (!deps.dry) await deps.flushReport()
	} finally {
		lock.release() // Python line 2186
	}
	return lines
}

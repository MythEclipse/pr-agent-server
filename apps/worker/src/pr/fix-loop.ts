// FIX UNTIL CI IS GREEN — the loop the worker never had.
//
// THE PROBLEM, measured rather than theorised. `runAiFix` ends the moment it has
// pushed a commit. Nothing then asks whether the push actually made CI pass. The
// next tick sees `alreadyFixed` for the new head, prints `⏭️ Already fixed at this
// SHA`, and waits — so a fix that did NOT work is indistinguishable from one that
// did, until the head happens to move for some other reason. mcpedia#28 sat in
// exactly that state for 97 consecutive ticks.
//
// `AI_FIX_RETRY_CEILING` (3) bounds a *re-offer* at one SHA, which is the wrong
// lever here: after a real push the SHA HAS moved, so the ceiling resets and the
// next run is another blind 30-minute attempt with the same generic prompt.
//
// What this module adds: after a push, WAIT for GitHub to finish reporting CI on
// the new head, then loop — with the NEW failure read as evidence — until CI is
// green, or the iteration budget is spent. Each iteration is a fresh agent run
// whose prompt contains what actually failed last time, so the loop converges
// instead of repeating.
//
// WHY THE BUDGET IS SMALL AND HARD. Every iteration is up to `AI_FIX_TIMEOUT`
// (1800s) of a paid model. Three iterations is an hour and a half on ONE PR, and
// the whole tick runs under a lockfile with a 5-minute cadence. So the loop is
// deliberately bounded, and it reports every iteration so the operator can see it
// spending that budget rather than discovering it afterwards.

import { type CiResult, checkCiPassed, checkCiWithSuiteRequirement } from "./ci.ts"
import type { GhClient } from "./scan.ts"

/** How many fix→wait→re-check iterations one tick may do. */
export const MAX_FIX_ITERATIONS = 3

/**
 * How long to wait for CI to settle on a pushed head, in one poll.
 *
 * GitHub needs to queue a runner, run the suite, and report. On this infra a CI
 * run takes ~1.5–4 minutes, so 20s polls with a 10-minute ceiling is enough to
 * cover a normal run and gives up on a wedged one.
 */
export const CI_POLL_INTERVAL_MS = 20_000
export const CI_WAIT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Check names that must have run for a GREEN verdict to be believed.
 *
 * `verify` is this repo's CI job (`.github/workflows/ci.yml`). Without a requirement
 * like this, a head with NO workflow run reads as green — which is exactly what the
 * `[skip ci]` fix commit produced: one third-party check, zero failing, zero pending,
 * verdict green, on a commit that was never tested. The worker merged that PR.
 *
 * A repo whose job is named differently is simply not covered; the requirement only
 * ever ADDS refusal.
 */
export const EXPECTED_CI_CHECKS: readonly string[] = ["verify"]

export interface PollOpts {
	/** Injected so tests do not wait in real time. */
	sleep: (ms: number) => Promise<void>
	now?: () => number
	intervalMs?: number
	timeoutMs?: number
	/**
	 * Check names that must have reported for a GREEN verdict to be believed.
	 *
	 * Empty means "trust whatever GitHub says", which is right for a caller with no
	 * expectation and wrong for the fix loop, where the point is to prove the push
	 * was actually tested.
	 */
	expectedChecks?: readonly string[]
}

export interface PollResult {
	/** The final verdict. `unknown` (could not read) is passed through. */
	ci: CiResult
	/** How many polls it took — 1 means it was already settled. */
	polls: number
	/** True when the wait timed out with checks still pending. */
	timedOut: boolean
}

/**
 * Wait until CI on `sha` is no longer PENDING, then return its verdict.
 *
 * "Pending" is the only state worth waiting on. A red CI is a FINAL answer and is
 * returned immediately: waiting on it would burn ten minutes to learn what the
 * first poll already said.
 *
 * There is no early exit for "still pending after a new push" — the caller passes
 * the head it just created, and the previous head's checks are irrelevant.
 */
export async function waitForCiSettled(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
	opts: PollOpts,
): Promise<PollResult> {
	const interval = opts.intervalMs ?? CI_POLL_INTERVAL_MS
	const timeout = opts.timeoutMs ?? CI_WAIT_TIMEOUT_MS
	const now = opts.now ?? Date.now
	const deadline = now() + timeout

	let polls = 0
	let last: CiResult = { ok: false, unknown: true, msg: "CI not read yet" }
	for (;;) {
		polls += 1
		last = opts.expectedChecks?.length
			? await checkCiWithSuiteRequirement(api, token, repo, sha, opts.expectedChecks)
			: await checkCiPassed(api, token, repo, sha)

		// A red CI is final. So is green. Only "pending" (and a read we could not
		// perform) is worth another look.
		const pending = !last.ok && !last.unknown && last.msg.startsWith("CI pending")
		if (!pending) return { ci: last, polls, timedOut: false }
		if (now() >= deadline) return { ci: last, polls, timedOut: true }

		await opts.sleep(interval)
	}
}

/**
 * Is another fix iteration worth attempting?
 *
 * Stops on: green (done), unknown (the gate cannot be read, so a fix would be
 * aimed at nothing), a spent budget, or the wait timing out. An unknown verdict is
 * NOT an invitation to retry — that was the failure mode where GitHub 5xx made
 * every check read empty and the worker treated silence as a pass; here it would
 * make a loop that fixes nothing, repeatedly.
 */
export function shouldIterateAgain(
	verdict: PollResult,
	iteration: number,
	maxIterations: number = MAX_FIX_ITERATIONS,
): boolean {
	if (verdict.ci.ok) return false
	if (verdict.ci.unknown) return false
	if (verdict.timedOut) return false
	return iteration < maxIterations
}

/** One line per iteration, so the operator can see the budget being spent. */
export function iterationLine(iteration: number, max: number, ci: CiResult): string {
	return `   🔁 Fix iteration ${iteration}/${max}: ${ci.msg}`
}

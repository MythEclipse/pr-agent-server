// THE LOOP THAT WAS MISSING.
//
// `runAiFix` ended the moment it pushed a commit. Nothing then asked whether the
// push made CI pass, so a fix that did not work was indistinguishable from one that
// did — the head moved, the next tick printed `Already fixed at this SHA`, and the PR
// waited indefinitely. mcpedia#28 sat there for 97 consecutive ticks.
//
// These tests pin the loop's contract: it waits only on PENDING, treats red and green
// as final, refuses to spin on an unreadable gate, and always terminates on a budget.

import { describe, expect, it } from "vitest"
import type { CiResult } from "../src/pr/ci.ts"
import {
	CI_WAIT_TIMEOUT_MS,
	iterationLine,
	MAX_FIX_ITERATIONS,
	type PollResult,
	shouldIterateAgain,
	waitForCiSettled,
} from "../src/pr/fix-loop.ts"
import type { GhClient } from "../src/pr/scan.ts"

/** A GhClient that returns each canned verdict in turn, then repeats the last. */
function sequencedApi(verdicts: Array<{ ok: boolean; msg: string; unknown?: boolean }>): GhClient {
	let i = 0
	return {
		async request() {
			const v = verdicts[Math.min(i, verdicts.length - 1)]
			i += 1
			const checks = v.ok
				? [{ name: "ci", status: "completed", conclusion: "success" }]
				: v.msg.startsWith("CI pending")
					? [{ name: "ci", status: "queued", conclusion: null }]
					: v.unknown
						? []
						: [{ name: "ci", status: "completed", conclusion: "failure" }]
			return { status: v.unknown ? 500 : 200, data: { check_runs: checks } }
		},
	} as unknown as GhClient
}

const noSleep = async () => {}

describe("waitForCiSettled", () => {
	it("returns GREEN immediately without polling twice", async () => {
		const api = sequencedApi([{ ok: true, msg: "✅ 1 checks green" }])
		const got = await waitForCiSettled(api, "t", "o/r", "sha", { sleep: noSleep })
		expect(got.ci.ok).toBe(true)
		expect(got.polls).toBe(1)
		expect(got.timedOut).toBe(false)
	})

	it("returns RED immediately — a red CI is a final answer", async () => {
		// Waiting on red would burn the whole timeout to learn what poll 1 said.
		const api = sequencedApi([{ ok: false, msg: "CI FAILED: ci" }])
		const got = await waitForCiSettled(api, "t", "o/r", "sha", { sleep: noSleep })
		expect(got.ci.ok).toBe(false)
		expect(got.polls).toBe(1)
	})

	it("keeps polling while CI is PENDING, then reports the verdict", async () => {
		const api = sequencedApi([
			{ ok: false, msg: "CI pending: ci" },
			{ ok: false, msg: "CI pending: ci" },
			{ ok: true, msg: "✅ 1 checks green" },
		])
		const got = await waitForCiSettled(api, "t", "o/r", "sha", { sleep: noSleep })
		expect(got.ci.ok).toBe(true)
		expect(got.polls).toBe(3)
	})

	it("gives up with timedOut when pending never settles", async () => {
		const api = sequencedApi([{ ok: false, msg: "CI pending: ci" }])
		const got = await waitForCiSettled(api, "t", "o/r", "sha", {
			sleep: noSleep,
			// A clock that advances past the deadline on the second read.
			now: (() => {
				let t = 0
				return () => {
					t += CI_WAIT_TIMEOUT_MS
					return t
				}
			})(),
		})
		expect(got.timedOut).toBe(true)
		expect(got.ci.ok).toBe(false)
	})
})

const verdict = (over: Partial<PollResult> = {}): PollResult => ({
	ci: { ok: false, msg: "CI FAILED: ci" },
	polls: 1,
	timedOut: false,
	...over,
})

describe("shouldIterateAgain", () => {
	const red: CiResult = { ok: false, msg: "CI FAILED: ci" }

	it("stops on green", () => {
		expect(shouldIterateAgain(verdict({ ci: { ok: true, msg: "green" } }), 1)).toBe(false)
	})

	it("keeps going on red while budget remains", () => {
		expect(shouldIterateAgain(verdict({ ci: red }), 1, 3)).toBe(true)
		expect(shouldIterateAgain(verdict({ ci: red }), 2, 3)).toBe(true)
	})

	it("stops when the budget is spent", () => {
		expect(shouldIterateAgain(verdict({ ci: red }), 3, 3)).toBe(false)
	})

	it("does NOT iterate on an UNKNOWN gate", () => {
		// A fix aimed at an unreadable failure is guesswork, and silence is not a
		// pass. This is the arm that would otherwise loop forever during a GitHub
		// outage.
		expect(
			shouldIterateAgain(verdict({ ci: { ok: false, msg: "⚠️ nope", unknown: true } }), 1),
		).toBe(false)
	})

	it("does not iterate after a wait timed out", () => {
		// A pending run that never settles means the runner is wedged; re-running the
		// agent against the same head adds cost and no evidence.
		expect(shouldIterateAgain(verdict({ ci: red, timedOut: true }), 1)).toBe(false)
	})

	it("defaults its budget to MAX_FIX_ITERATIONS", () => {
		expect(shouldIterateAgain(verdict({ ci: red }), MAX_FIX_ITERATIONS - 1)).toBe(true)
		expect(shouldIterateAgain(verdict({ ci: red }), MAX_FIX_ITERATIONS)).toBe(false)
	})
})

describe("iterationLine", () => {
	it("names the iteration and the failure so the spend is visible", () => {
		const line = iterationLine(2, 3, { ok: false, msg: "CI FAILED: api:test" })
		expect(line).toContain("2/3")
		expect(line).toContain("api:test")
	})
})

// Does the loop actually ITERATE, and does each pass see the NEW failure?
//
// The unit tests in fix-loop.test.ts pin the polling contract. These drive the real
// `runAiFix` against a stubbed agent + GitHub and assert the thing that matters: the
// prompt handed to the SECOND agent run contains the failure from the FIRST, not the
// same generic text again. That difference is the whole reason the loop can converge
// where a repeated single-shot run could not.

import { describe, expect, it } from "vitest"
import type { ProcResult } from "../src/lib/proc.ts"
import { type AiFixDeps, runAiFix } from "../src/pr/autofix.ts"
import type { GhClient } from "../src/pr/scan.ts"

/** The prompts the fake agent received, in order. */
interface Captured {
	prompts: string[]
}

/**
 * A fake worker world: git commands succeed, `rev-list` reports a commit after each
 * agent run (so a push always happens), and GitHub reports a RED CI whose failing
 * job NAME changes per call — so the second prompt must contain a different failure
 * than the first.
 */
function makeWorld(captured: Captured, ciFailuresPerCall: string[]) {
	let revListCalls = 0
	let checkCall = 0

	const run = (cmd: readonly string[]): ProcResult => {
		const [first] = cmd
		if (first === "rev-list") {
			revListCalls += 1
			return { code: 0, stdout: String(revListCalls), stderr: "", exitedDueToTimeout: false }
		}
		if (first === "rev-parse") {
			return { code: 0, stdout: "a".repeat(40), stderr: "", exitedDueToTimeout: false }
		}
		if (first === "diff") {
			return { code: 0, stdout: "src/changed.ts\n", stderr: "", exitedDueToTimeout: false }
		}
		return { code: 0, stdout: "", stderr: "", exitedDueToTimeout: false }
	}

	const api = {
		async request(_m: string, path: string) {
			// ORDER MATTERS: the annotations path also CONTAINS `/check-runs`
			// (`/repos/o/r/check-runs/1/annotations`), so it must be tested first or
			// every annotations read returns the check-runs envelope.
			if (path.includes("/annotations")) {
				const name = ciFailuresPerCall[Math.min(checkCall - 1, ciFailuresPerCall.length - 1)]
				return {
					status: 200,
					data: [
						{
							path: "src/x.ts",
							start_line: 5,
							annotation_level: "failure",
							message: `${name} broke`,
						},
					],
				}
			}
			// check-runs list: the red job for THIS call
			if (path.includes("/check-runs")) {
				const name = ciFailuresPerCall[Math.min(checkCall, ciFailuresPerCall.length - 1)]
				checkCall += 1
				return {
					status: 200,
					data: {
						check_runs: [{ id: checkCall, name, status: "completed", conclusion: "failure" }],
					},
				}
			}
			if (path.includes("/files")) return { status: 200, data: [] }
			return { status: 200, data: {} }
		},
	} as unknown as GhClient

	const agent = {
		async post(prompt: string) {
			captured.prompts.push(prompt)
			return { ok: true, snippet: "" }
		},
	}

	const deps = {
		run,
		exec: run,
		api,
		agent,
		workdirs: {
			exists: () => true,
			remove: () => {},
			mkdir: () => {},
			sweepStale: () => 0,
		},
		procs: { kill: () => {} },
		report: { push: () => {} },
	} as unknown as AiFixDeps

	return deps
}

describe("runAiFix feeds each pass the CURRENT CI failure", () => {
	it("puts the real failure in the prompt instead of the generic text", async () => {
		const captured: Captured = { prompts: [] }
		const deps = makeWorld(captured, ["api:test"])

		await runAiFix(deps, "o/r", 1, "title", "0".repeat(40), "feat", "main", "tok")

		expect(captured.prompts).toHaveLength(1)
		expect(captured.prompts[0]).toContain("CI IS FAILING")
		expect(captured.prompts[0]).toContain("api:test")
		expect(captured.prompts[0]).toContain("src/x.ts:5")
	})

	it("shows a DIFFERENT failure on the second run, not the first again", async () => {
		// This is the convergence property: the loop is only useful if pass 2 is
		// informed by what pass 1's push actually left broken.
		const captured: Captured = { prompts: [] }
		const deps = makeWorld(captured, ["api:test", "lint"])

		await runAiFix(deps, "o/r", 1, "title", "0".repeat(40), "feat", "main", "tok")
		await runAiFix(deps, "o/r", 1, "title", "1".repeat(40), "feat", "main", "tok")

		expect(captured.prompts).toHaveLength(2)
		expect(captured.prompts[0]).toContain("api:test")
		expect(captured.prompts[1]).toContain("lint")
		expect(captured.prompts[1]).not.toContain("api:test")
	})

	it("degrades to the ORIGINAL prompt when CI is green or unreadable", async () => {
		// An ordinary run must stay byte-identical to what it always was.
		const captured: Captured = { prompts: [] }
		const deps = makeWorld(captured, [])
		;(deps.api as unknown as { request: unknown }).request = async () => ({
			status: 200,
			data: { check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] },
		})

		await runAiFix(deps, "o/r", 1, "title", "0".repeat(40), "feat", "main", "tok")

		expect(captured.prompts[0]).not.toContain("CI IS FAILING")
		expect(captured.prompts[0]).toContain("ONLY modify the files listed above")
	})
})

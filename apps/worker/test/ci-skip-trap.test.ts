// A GREEN VERDICT FOR A HEAD THAT WAS NEVER TESTED.
//
// Found by running the fix-until-green loop against a real PR, not by reading code.
// The AI fix committed with `fix: auto-fix code quality [skip ci]` — a message
// transcribed from the Python — and `[skip ci]` is honoured by GitHub Actions. So no
// workflow ran on the commit the agent had just pushed. The only check on that head
// was a third-party security app.
//
// `checkCiPassed` then counted zero failing and zero pending checks and answered
// `✅ 1 checks green`. That is the "no CI configured is a pass" rule working exactly
// as written, and it was catastrophic here: the fix was never verified, AND the merge
// gate would have approved and merged on it. A red PR could be merged by its own
// unverified fix.
//
// These tests pin the two halves of the fix: the marker is gone from the prompt, and a
// head with no real suite reporting is refused rather than believed.

import { describe, expect, it } from "vitest"
import { buildAiFixPrompt } from "../src/pr/autofix.ts"
import { checkCiWithSuiteRequirement } from "../src/pr/ci.ts"
import { EXPECTED_CI_CHECKS } from "../src/pr/fix-loop.ts"
import type { GhClient } from "../src/pr/scan.ts"

function apiWith(
	checks: Array<{ name: string; status?: string; conclusion?: string | null }>,
): GhClient {
	return {
		async request() {
			return {
				status: 200,
				data: {
					check_runs: checks.map((c) => ({
						name: c.name,
						status: c.status ?? "completed",
						conclusion: c.conclusion === undefined ? "success" : c.conclusion,
					})),
				},
			}
		},
	} as unknown as GhClient
}

describe("a head with no real suite is NOT green", () => {
	it("refuses green when only a third-party check reported (the real [skip ci] shape)", async () => {
		// Exactly what the probe PR looked like: one security app, no workflow run.
		const api = apiWith([{ name: "GitGuardian Security Checks" }])
		const got = await checkCiWithSuiteRequirement(api, "t", "o/r", "sha", EXPECTED_CI_CHECKS)
		expect(got.ok).toBe(false)
		expect(got.unknown).toBe(true)
		expect(got.msg).toContain("No real CI ran")
	})

	it("accepts green when the real job DID report", async () => {
		const api = apiWith([{ name: "verify" }, { name: "GitGuardian Security Checks" }])
		const got = await checkCiWithSuiteRequirement(api, "t", "o/r", "sha", EXPECTED_CI_CHECKS)
		expect(got.ok).toBe(true)
	})

	it("passes a RED verdict through untouched", async () => {
		// The requirement only ADDS refusal. A red suite must stay red, and must not
		// be relabelled "unknown" — the caller reports those differently.
		const api = apiWith([{ name: "verify", conclusion: "failure" }])
		const got = await checkCiWithSuiteRequirement(api, "t", "o/r", "sha", EXPECTED_CI_CHECKS)
		expect(got.ok).toBe(false)
		expect(got.unknown).toBeUndefined()
		expect(got.msg).toContain("CI FAILED")
	})

	it("passes a PENDING verdict through untouched", async () => {
		const api = apiWith([{ name: "verify", status: "queued", conclusion: null }])
		const got = await checkCiWithSuiteRequirement(api, "t", "o/r", "sha", EXPECTED_CI_CHECKS)
		expect(got.ok).toBe(false)
		expect(got.unknown).toBeUndefined()
		expect(got.msg).toContain("pending")
	})

	it("with an empty requirement, behaves exactly like the old gate", async () => {
		// Callers with no expectation (a repo with no CI at all) must not be broken
		// by the stricter check.
		const api = apiWith([{ name: "whatever" }])
		const got = await checkCiWithSuiteRequirement(api, "t", "o/r", "sha", [])
		expect(got.ok).toBe(true)
	})
})

describe("the fix commit must let CI run", () => {
	it("does NOT ask for [skip ci] in the commit message", () => {
		// `[skip ci]` suppressed the run on the very commit meant to fix CI.
		const prompt = buildAiFixPrompt(1, "o/r", "t", "main", ["a.ts"])
		expect(prompt).not.toContain("[skip ci]")
		expect(prompt).toContain('git commit --message="fix: auto-fix code quality"')
	})

	it("still forbids pushing (the worker validates before it pushes)", () => {
		const prompt = buildAiFixPrompt(1, "o/r", "t", "main", ["a.ts"])
		expect(prompt).toContain("Do NOT push")
	})
})

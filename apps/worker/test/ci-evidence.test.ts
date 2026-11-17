// The AI fix used to receive one generic prompt on every run: "improve code quality
// of ALL changed files". Nothing about WHY the PR is stuck. A red CI caused by a real
// failure is the case that blocks the queue, and the agent was never told about it —
// measured on mcpedia#28, which sat on `Already fixed at this SHA` for 97 ticks while
// CI was red, because a dev-dependency bump has nothing to "improve".
//
// These tests pin the evidence path: what is extracted from GitHub, what reaches the
// prompt, the caps that keep a stack trace from crowding out the diff, and the rule
// that an ordinary run's prompt is unchanged.

import { describe, expect, it } from "vitest"
import { buildAiFixPrompt } from "../src/pr/autofix.ts"
import {
	ciFailureSection,
	collectCiFailures,
	renderCiFailures,
	type TCiFailure,
} from "../src/pr/ci-evidence.ts"
import type { GhClient } from "../src/pr/scan.ts"

/** A GhClient whose responses are canned per path. */
function stubApi(routes: Record<string, { status: number; data: unknown }>): GhClient {
	return {
		async request(_method: string, path: string) {
			// Query strings are stripped before the lookup: the check-run list is
			// read PAGED (`?per_page=100&page=N`), and the fixtures describe paths.
			const hit = routes[path] ?? routes[path.replace(/\?.*$/, "")]
			// An unmatched path is a 404 rather than a throw: the module's contract is
			// "best-effort, never throws", so the stub must not be stricter than the
			// thing it stands in for.
			return hit ?? { status: 404, data: null }
		},
	} as unknown as GhClient
}

const failure = (over: Partial<TCiFailure> = {}): TCiFailure => ({
	name: "api:test",
	conclusion: "failure",
	annotations: [],
	output: "",
	...over,
})

describe("collectCiFailures", () => {
	it("does NOT hand the worker's own merge job to the agent as CI evidence", async () => {
		// The auto-merge workflow reports `failure` when it DECLINED to merge and
		// `cancelled` when a newer run superseded it — neither says anything about
		// the code. `ci.ts` filters these names before judging a head; this reader
		// had no such filter, so a PR whose only red check was the worker's own
		// merge job got a prompt saying "CI IS FAILING … ### Auto-merge dependency
		// PR — cancelled", and the agent was invited to "fix" merge tooling.
		const api = stubApi({
			"/repos/o/r/commits/abc/check-runs": {
				status: 200,
				data: {
					check_runs: [
						{
							id: 9,
							name: "Auto-merge dependency PR",
							status: "completed",
							conclusion: "cancelled",
						},
						{ id: 7, name: "api:test", status: "completed", conclusion: "failure" },
					],
				},
			},
		})
		const got = await collectCiFailures(api, "t", "o/r", "abc")
		expect(got.map((f) => f.name)).toEqual(["api:test"])
	})

	it("reads a failing check and its annotations", async () => {
		const api = stubApi({
			"/repos/o/r/commits/abc/check-runs": {
				status: 200,
				data: {
					check_runs: [{ id: 7, name: "api:test", status: "completed", conclusion: "failure" }],
				},
			},
			"/repos/o/r/check-runs/7/annotations": {
				status: 200,
				data: [
					{
						path: "src/a.ts",
						start_line: 42,
						annotation_level: "failure",
						message: "expected 1 to be 2",
					},
				],
			},
		})
		const got = await collectCiFailures(api, "t", "o/r", "abc")
		expect(got).toHaveLength(1)
		expect(got[0]?.name).toBe("api:test")
		expect(got[0]?.annotations[0]).toMatchObject({ path: "src/a.ts", line: 42 })
	})

	it("keeps the failures it already read when a later page fails", async () => {
		// `status !== 200` used to return `[]`, discarding runs already in hand: a
		// red job read from page 1 vanished from the prompt because page 2 timed
		// out, and the agent was told there was no CI evidence at all. Partial
		// evidence is still evidence.
		const fullPage = Array.from({ length: 100 }, (_, i) => ({
			id: i,
			name: `test (${i})`,
			status: "completed",
			conclusion: i === 3 ? "failure" : "success",
		}))
		const api = {
			async request(_method: string, path: string) {
				// Parse the page number, do NOT substring-match it: every URL here
				// carries `per_page=100`, which contains `page=1`.
				const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "0")
				if (page === 1) return { status: 200, data: { check_runs: fullPage } }
				if (page === 2) return { status: 500, data: null }
				return { status: 404, data: null }
			},
		} as unknown as GhClient

		const got = await collectCiFailures(api, "t", "o/r", "abc")

		expect(got.map((f) => f.name)).toEqual(["test (3)"])
	})

	it("ignores notice and warning annotations", async () => {
		// Observed on a real `hub` run: a `notice` about the ubuntu-latest image
		// migration sat right after the actual error, and handing that to an agent
		// invites it to "fix" an unrelated runner label.
		const api = stubApi({
			"/repos/o/r/commits/abc/check-runs": {
				status: 200,
				data: { check_runs: [{ id: 7, name: "ci", status: "completed", conclusion: "failure" }] },
			},
			"/repos/o/r/check-runs/7/annotations": {
				status: 200,
				data: [
					{ path: ".github", annotation_level: "notice", message: "runner label will migrate" },
					{ path: "src/a.ts", annotation_level: "failure", message: "real error" },
				],
			},
		})
		const got = await collectCiFailures(api, "t", "o/r", "abc")
		expect(got[0]?.annotations.map((a) => a.message)).toEqual(["real error"])
	})

	it("skips check runs that passed or are still running", async () => {
		const api = stubApi({
			"/repos/o/r/commits/abc/check-runs": {
				status: 200,
				data: {
					check_runs: [
						{ id: 1, name: "ok", status: "completed", conclusion: "success" },
						{ id: 2, name: "running", status: "in_progress", conclusion: null },
						{ id: 3, name: "red", status: "completed", conclusion: "timed_out" },
					],
				},
			},
		})
		const got = await collectCiFailures(api, "t", "o/r", "abc")
		expect(got.map((f) => f.name)).toEqual(["red"])
	})

	it("returns [] instead of throwing when GitHub is unreadable", async () => {
		// The whole module is best-effort: a prompt with no evidence is the prompt
		// that already existed, and an exception here would take the PR down.
		expect(await collectCiFailures(stubApi({}), "t", "o/r", "abc")).toEqual([])
		expect(
			await collectCiFailures(
				stubApi({ "/repos/o/r/commits/abc/check-runs": { status: 500, data: null } }),
				"t",
				"o/r",
				"abc",
			),
		).toEqual([])
	})

	it("caps the number of reported jobs", async () => {
		const runs = Array.from({ length: 8 }, (_, i) => ({
			id: i,
			name: `job${i}`,
			status: "completed",
			conclusion: "failure",
		}))
		const api = stubApi({
			"/repos/o/r/commits/abc/check-runs": { status: 200, data: { check_runs: runs } },
		})
		const got = await collectCiFailures(api, "t", "o/r", "abc")
		expect(got).toHaveLength(3)
	})
})

describe("ciFailureSection", () => {
	it("is EMPTY with no evidence, so an ordinary run keeps the original prompt", () => {
		expect(ciFailureSection([])).toBe("")
		expect(renderCiFailures([])).toBe("")
	})

	it("names the file and line the failure points at", () => {
		const text = ciFailureSection([
			failure({ annotations: [{ path: "src/a.ts", line: 42, level: "failure", message: "boom" }] }),
		])
		expect(text).toContain("[src/a.ts:42] boom")
	})

	it("forbids editing CI to hide a failure", () => {
		// The failure mode a capable agent reaches for: green the build by changing
		// the workflow. That produces a passing PR that fixed nothing.
		const text = ciFailureSection([
			failure({ annotations: [{ path: "", line: null, level: "failure", message: "x" }] }),
		])
		expect(text).toMatch(/do NOT edit/i)
		expect(text).toMatch(/workflow/i)
	})

	it("says so when a job published no annotation at all", () => {
		const text = ciFailureSection([failure()])
		expect(text).toContain("no annotation or log summary")
	})

	it("stays inside its character budget for a pathological annotation", () => {
		const huge = "x".repeat(50_000)
		const text = ciFailureSection([
			failure({
				annotations: [
					{ path: "a", line: 1, level: "failure", message: huge },
					{ path: "b", line: 2, level: "failure", message: huge },
				],
				output: huge,
			}),
		])
		// Per-message and total caps both apply; the exact number is less important
		// than "bounded", because the prompt also has to carry the diff.
		expect(text.length).toBeLessThan(8000)
	})
})

describe("the prompt", () => {
	const files = ["apps/api/src/a.ts"]

	it("without evidence is unchanged — no CI section, same task list", () => {
		const prompt = buildAiFixPrompt(1, "o/r", "t", "main", files)
		expect(prompt).not.toContain("CI IS FAILING")
		expect(prompt).toContain("git merge origin/main --no-edit")
		expect(prompt).toContain('EXACTLY "fix: auto-fix code quality"')
	})

	it("puts the failures BEFORE the generic task list", () => {
		// A model that reads "improve code quality" first plans against it and
		// treats a later failure list as an aside.
		const prompt = buildAiFixPrompt(
			1,
			"o/r",
			"t",
			"main",
			files,
			ciFailureSection([
				failure({ annotations: [{ path: "a.ts", line: 1, level: "failure", message: "boom" }] }),
			]),
		)
		expect(prompt.indexOf("CI IS FAILING")).toBeLessThan(prompt.indexOf("Your task:"))
		expect(prompt).toContain("boom")
	})

	it("keeps the load-bearing rules when evidence is present", () => {
		// "Do NOT push" is the boundary that keeps the agent from pushing a commit
		// the worker has not validated — it holds in BOTH modes.
		const prompt = buildAiFixPrompt(1, "o/r", "t", "main", files, ciFailureSection([failure()]))
		expect(prompt).toContain("Do NOT push")
		expect(prompt).toContain("Resolve merge conflicts carefully")
	})

	it("relaxes the file scope ONLY when evidence is present", () => {
		// A red CI is very often caused by a file the PR did not touch (a test
		// asserting old behaviour, an invalidated type). Keeping "ONLY these files"
		// would force the agent to ignore the evidence it was just given.
		const without = buildAiFixPrompt(1, "o/r", "t", "main", files)
		expect(without).toContain("ONLY modify the files listed above")
		expect(without).not.toContain("you MAY edit other files")

		const withEvidence = buildAiFixPrompt(
			1,
			"o/r",
			"t",
			"main",
			files,
			ciFailureSection([failure()]),
		)
		expect(withEvidence).toContain("you MAY edit other files")
		expect(withEvidence).not.toContain("ONLY modify the files listed above")
	})
})

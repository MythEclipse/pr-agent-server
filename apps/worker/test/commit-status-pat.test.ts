import { describe, expect, it } from "vitest"
import { checkCiPassed } from "../src/pr/ci.ts"
import { checkCommitStatus } from "../src/pr/commit-status.ts"

/**
 * THE BUG THIS FILE PINS: the App installation on this fleet has `checks`,
 * `issues`, `contents`, `metadata`, `pull_requests` — and NOT `statuses`. So
 * `GET /commits/{sha}/status` answered 403 on every head, the gate reported
 * `unknown`, and every caller treats unknown as "wait for the next tick". The PR
 * waited forever and the report blamed a transient GitHub fault:
 *
 *   ⏳ CI unknown (⚠️ Commit status unavailable (HTTP 403)) — not spending an agent run
 *
 * Probed with a real installation token on MythEclipse/web1#24:
 *   403  /repos/MythEclipse/web1/commits/<sha>/status
 *        x-accepted-github-permissions: statuses=read
 *   200  /repos/MythEclipse/web1/commits/<sha>/check-runs
 * and the owner PAT answers 200 on the same URL (`repo` scope covers statuses).
 */

/** A client that answers by token, so the fallback is what is being tested. */
function api(routes: Record<string, { status: number; data?: unknown }>) {
	const calls: { path: string; token: string }[] = []
	return {
		calls,
		request: async (_method: string, path: string, opts?: { token?: string }) => {
			calls.push({ path, token: opts?.token ?? "" })
			const hit = routes[`${path}|${opts?.token ?? ""}`]
			if (hit) return { status: hit.status, data: hit.data }
			return { status: 404, data: undefined }
		},
	}
}

const SHA = "33a6ca4"
const STATUS = `/repos/o/r/commits/${SHA}/status`
const CHECKS = `/repos/o/r/commits/${SHA}/check-runs?per_page=100&page=1`

const greenChecks = {
	status: 200,
	data: {
		total_count: 1,
		check_runs: [
			{
				name: "verify",
				status: "completed",
				conclusion: "success",
				app: { slug: "github-actions" },
			},
		],
	},
}

describe("commit status with an App that cannot read statuses", () => {
	it("falls back to the owner PAT instead of reporting an unknown gate", async () => {
		const client = api({
			[`${STATUS}|app`]: {
				status: 403,
				data: { message: "Resource not accessible by integration" },
			},
			[`${STATUS}|pat`]: {
				status: 200,
				data: { state: "success", total_count: 1, statuses: [{ state: "success", context: "ci" }] },
			},
		})
		const res = await checkCommitStatus(client as never, "app", "o/r", SHA, "pat")
		expect(res.blocked).toBeUndefined()
		expect(res.count).toBe(1)
		// Both tokens were tried, the App first: it is the identity the rest of the
		// pipeline uses, and the PAT only fills a permission hole.
		expect(client.calls.map((c) => c.token)).toEqual(["app", "pat"])
	})

	it("still reports unknown when BOTH tokens are refused, and names the permission", async () => {
		const client = api({
			[`${STATUS}|app`]: { status: 403 },
			[`${STATUS}|pat`]: { status: 403 },
		})
		const res = await checkCommitStatus(client as never, "app", "o/r", SHA, "pat")
		expect(res.blocked?.unknown).toBe(true)
		// "HTTP 403" alone sent the operator looking at the repo, the branch and the
		// token's expiry — none of which was the problem.
		expect(res.blocked?.msg).toContain("statuses: read")
		expect(res.blocked?.msg).toContain("as the owner PAT")
	})

	it("does not use the PAT for a transient 5xx", async () => {
		const client = api({ [`${STATUS}|app`]: { status: 500 } })
		const res = await checkCommitStatus(client as never, "app", "o/r", SHA, "pat")
		expect(res.blocked?.unknown).toBe(true)
		// One call only: the PAT would hit the same incident, and a 5xx is honestly
		// unreadable rather than a permission problem.
		expect(client.calls).toHaveLength(1)
	})

	it("keeps the old behaviour when no PAT is configured", async () => {
		const client = api({ [`${STATUS}|app`]: { status: 403 } })
		const res = await checkCommitStatus(client as never, "app", "o/r", SHA, "")
		expect(res.blocked?.unknown).toBe(true)
		expect(client.calls).toHaveLength(1)
	})
})

describe("every reader of the combined status gets the PAT", () => {
	/**
	 * A STATIC check, because the bug it prevents was a MISSING ARGUMENT at one of
	 * five call sites. Measured live: the fix loop printed
	 *
	 *   ✅ CI already green (✅ 1 checks green) — no fix needed, going to the merge gate
	 *   🧪 CI: ⚠️ Commit status unavailable (HTTP 403) — no owner PAT was available
	 *
	 * — two gates, one credential, opposite verdicts, and the merge gate was the one
	 * that had been left out. A unit test of `checkCiPassed` cannot see that, and a
	 * reviewer cannot reliably see it either, so the wiring is asserted.
	 */
	it("passes the PAT at every call site in src", async () => {
		const { readFileSync, readdirSync, statSync } = await import("node:fs")
		const { join } = await import("node:path")
		const root = join(import.meta.dirname, "..", "src")

		const files: string[] = []
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry)
				if (statSync(full).isDirectory()) walk(full)
				else if (full.endsWith(".ts")) files.push(full)
			}
		}
		walk(root)

		/**
		 * Strip comments BEFORE scanning. The first version of this test used
		 * `fn\([^)]*\)` and matched nothing useful: a call site's own explanatory
		 * comment contains `(HTTP 403)`, so the regex stopped at that paren and the
		 * "call" it captured was a fragment with no arguments at all — the check
		 * failed on a file that was already correct. A regex over source is only
		 * worth having if it is run against source and not against prose.
		 */
		const stripComments = (src: string): string =>
			src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

		/** The full argument text of `fn(...)`, paren-balanced, so nested calls survive. */
		const callsTo = (src: string, fn: string): string[] => {
			const found: string[] = []
			const re = new RegExp(`\\b${fn}\\s*\\(`, "g")
			for (const match of src.matchAll(re)) {
				let depth = 0
				let i = (match.index ?? 0) + match[0].length - 1
				const start = i
				for (; i < src.length; i++) {
					if (src[i] === "(") depth += 1
					else if (src[i] === ")") {
						depth -= 1
						if (depth === 0) break
					}
				}
				found.push(src.slice(start, i + 1))
			}
			return found
		}

		const offenders: string[] = []
		for (const file of files) {
			if (file.endsWith("ci.ts") || file.endsWith("commit-status.ts")) continue
			const text = stripComments(readFileSync(file, "utf8"))
			for (const fn of ["checkCiPassed", "checkCiWithSuiteRequirement"]) {
				for (const call of callsTo(text, fn)) {
					if (call.includes("fetchGhToken") || call.includes("opts.pat") || call.includes(", pat"))
						continue
					offenders.push(`${file.split("/src/")[1]}: ${call.replace(/\s+/g, " ").slice(0, 90)}`)
				}
			}
		}
		expect(offenders).toEqual([])
	})
})

describe("checkCiPassed with the PAT fallback", () => {
	it("reaches a real verdict on a head the App's statuses permission cannot see", async () => {
		const client = api({
			[`${CHECKS}|app`]: greenChecks,
			[`${STATUS}|app`]: { status: 403 },
			[`${STATUS}|pat`]: { status: 200, data: { state: "success", total_count: 0, statuses: [] } },
		})
		const res = await checkCiPassed(client as never, "app", "o/r", SHA, "pat")
		// Before the fallback this was `unknown`, which the merge gate refuses
		// forever. Now it is the green verdict the checks actually support.
		expect(res).toEqual({ ok: true, msg: "✅ 1 checks green" })
	})

	it("still refuses to merge when both tokens fail", async () => {
		const client = api({
			[`${CHECKS}|app`]: greenChecks,
			[`${STATUS}|app`]: { status: 403 },
			[`${STATUS}|pat`]: { status: 403 },
		})
		const res = await checkCiPassed(client as never, "app", "o/r", SHA, "pat")
		expect(res.ok).toBe(false)
		expect(res.unknown).toBe(true)
	})
})

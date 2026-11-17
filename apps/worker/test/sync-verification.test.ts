import { describe, expect, test } from "vitest"
import type { GhClient } from "../src/pr/scan.ts"
import type { SyncState } from "../src/sync/config.ts"
import { pendingVerify } from "../src/sync/config.ts"
import { verifyPendingSyncs } from "../src/sync/verify.ts"

const NOW = 1_700_000_000
const SHA = "a".repeat(40)
const red = { name: "build", status: "completed", conclusion: "failure" }
const green = { name: "build", status: "completed", conclusion: "success" }

type Reply = { status: number; data: unknown }
function harness(
	checks: (page: number) => Reply,
	tip: Reply = { status: 200, data: { sha: SHA } },
) {
	const state: SyncState = {
		"f/x": {
			last_merged_upstream_sha: "upstream",
			pending_verify: {
				sha: SHA,
				pre_merge_sha: "before",
				branch: "main",
				pushed_at: NOW - 3600,
			},
		},
	}
	const requests: string[] = []
	const reverts: string[] = []
	const notifications: string[] = []
	let saves = 0
	let revertOk = true
	const api: GhClient = {
		request: async (_method, path) => {
			requests.push(path)
			if (!path.includes("/check-runs")) return tip
			return checks(Number(new URL(`http://x${path}`).searchParams.get("page")))
		},
	}
	const deps = {
		api,
		enabled: true,
		repoOverrides: {},
		now: () => NOW,
		saveState: () => {
			saves++
		},
		revertMerge: async (args: { expectedHeadSha: string }) => {
			reverts.push(args.expectedHeadSha)
			return { ok: revertOk, detail: revertOk ? "reverted" : "push denied" }
		},
		postDiscord: async (title: string) => {
			notifications.push(title)
			return true
		},
	}
	return {
		state,
		requests,
		reverts,
		notifications,
		deps,
		saves: () => saves,
		failRevert: () => {
			revertOk = false
		},
		recoverRevert: () => {
			revertOk = true
		},
	}
}
const reply = (runs: unknown[], total = runs.length): Reply => ({
	status: 200,
	data: { check_runs: runs, total_count: total },
})
const run = (h: ReturnType<typeof harness>) =>
	verifyPendingSyncs(h.deps, h.state, { "f/x": "token" })

describe("sync verification safeguards", () => {
	test("a human tip stops the watch without reading CI or rolling back", async () => {
		const h = harness(() => reply([red]), { status: 200, data: { sha: "human" } })
		await run(h)
		expect(h.reverts).toEqual([])
		expect(h.requests).toEqual(["/repos/f/x/commits/main"])
		expect(h.state["f/x"].pending_verify).toBeNull()
	})
	for (const tip of [
		{ status: 503, data: {} },
		{ status: 200, data: {} },
		{ status: 200, data: [{ sha: SHA }] },
	]) {
		test(`an unreadable tip never allows rollback (${JSON.stringify(tip)})`, async () => {
			const h = harness(() => reply([red]), tip)
			await run(h)
			expect(h.reverts).toEqual([])
			expect(pendingVerify(h.state["f/x"])?.sha).toBe(SHA)
			expect(h.saves()).toBe(0)
		})
	}
	for (const bad of [
		{ status: 503, data: {} },
		{ status: 200, data: {} },
		{ status: 200, data: null },
	]) {
		test(`unreadable CI keeps the watch beyond the grace period (${JSON.stringify(bad)})`, async () => {
			const h = harness(() => bad)
			const lines = await run(h)
			expect(pendingVerify(h.state["f/x"])?.sha).toBe(SHA)
			expect(h.saves()).toBe(0)
			expect(lines.some((l) => l.includes("verified green"))).toBe(false)
		})
	}
	test("follows a short page when total_count says another check exists", async () => {
		const h = harness((page) => (page === 1 ? reply(Array(30).fill(green), 31) : reply([red], 31)))
		await run(h)
		expect(h.requests.at(-1)).toContain("page=2")
		expect(h.reverts).toEqual([SHA])
	})
	test("a failure on a later page is not erased by a green first page", async () => {
		const h = harness((page) =>
			page === 1 ? reply(Array(100).fill(green), 101) : reply([red], 101),
		)
		await run(h)
		expect(h.reverts).toEqual([SHA])
	})
	test("an incomplete second page preserves the watch", async () => {
		const h = harness((page) =>
			page === 1 ? reply(Array(100).fill(green), 101) : { status: 503, data: {} },
		)
		await run(h)
		expect(pendingVerify(h.state["f/x"])?.sha).toBe(SHA)
		expect(h.reverts).toEqual([])
		expect(h.saves()).toBe(0)
	})
	test("a missing tail is not a completed list", async () => {
		const h = harness((page) => (page === 1 ? reply([green], 2) : reply([], 2)))
		await run(h)
		expect(pendingVerify(h.state["f/x"])?.sha).toBe(SHA)
		expect(h.saves()).toBe(0)
	})
	test("failed rollback stays armed and retries successfully on the next tick", async () => {
		const h = harness(() => reply([red]))
		h.failRevert()
		const lines = await run(h)
		expect(lines.some((l) => l.includes("rollback failed"))).toBe(true)
		expect(pendingVerify(h.state["f/x"])?.sha).toBe(SHA)
		expect(h.state["f/x"].last_merged_upstream_sha).toBe("upstream")
		expect(h.notifications).toEqual([])
		expect(h.saves()).toBe(0)
		h.recoverRevert()
		await run(h)
		expect(h.state["f/x"].pending_verify).toBeNull()
		expect(h.state["f/x"].last_merged_upstream_sha).toBe("")
		expect(h.reverts).toEqual([SHA, SHA])
		expect(h.notifications).toHaveLength(1)
	})
})

test("the sweep cannot replace a watch retained after failed rollback", async () => {
	const { sweepForks } = await import("../src/sync/sweep.ts")
	const h = harness(() => reply([red]))
	h.failRevert()
	await run(h)
	const requestsBefore = h.requests.length
	const deps = {
		...h.deps,
		run: () => {
			throw new Error("git must not run")
		},
		workdirs: {},
		agent: {},
		loadState: () => h.state,
		fetchGhToken: () => "",
		report: { push: () => {} },
	} as unknown as Parameters<typeof sweepForks>[0]
	const budget = await sweepForks(
		deps,
		async () => {
			throw new Error("sync must wait")
		},
		[["token", "f/x", "up/x", "main"]],
		h.state,
		[],
		{ dry: false, enabled: true, now: NOW, budget: 1 },
	)
	expect(budget).toBe(1)
	expect(h.requests).toHaveLength(requestsBefore)
	expect(pendingVerify(h.state["f/x"])?.sha).toBe(SHA)
})

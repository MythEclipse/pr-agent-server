import { describe, expect, test } from "vitest"
import { ReviewQueue } from "../src/application/queue/review-queue.ts"

const tick = () => new Promise((r) => setTimeout(r, 5))

describe("ReviewQueue", () => {
	test("dedupes the same repo+pr while a job is in flight, then re-runs it once", async () => {
		const ran: string[] = []
		// Object holder: TS narrows a bare `let` assigned only inside a closure to
		// `never` at the call site, which breaks `release?.()`.
		const gate: { release: (() => void) | null } = { release: null }
		const q = new ReviewQueue({
			run: async (j) => {
				ran.push(`${j.repo}#${j.pr}`)
				// Only the first attempt blocks; the coalesced re-run runs to completion.
				if (ran.length === 1) {
					await new Promise<void>((r) => {
						gate.release = r
					})
				}
			},
		})
		expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("queued")
		expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("deduped")
		await tick()
		gate.release?.()
		await q.drain()
		// The deduped webhook is coalesced into exactly one re-run, so the new head
		// the push introduced still gets reviewed.
		expect(ran).toEqual(["r#1", "r#1"])
	})

	test("coalesces a burst of deduped webhooks into a single re-run", async () => {
		const ran: string[] = []
		let release: () => void = () => {}
		const q = new ReviewQueue({
			run: async (j) => {
				ran.push(`${j.repo}#${j.pr}`)
				await new Promise<void>((r) => {
					release = r
				})
			},
		})
		q.enqueue({ owner: "o", repo: "r", pr: 1 })
		for (let i = 0; i < 5; i++) expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("deduped")
		await tick()
		release()
		// Release again for the coalesced re-run, then let the queue go idle.
		await tick()
		release()
		await q.drain()
		expect(ran).toEqual(["r#1", "r#1"])
	})

	test("a deduped re-run survives a failing first attempt", async () => {
		const ran: number[] = []
		let first = true
		const q = new ReviewQueue({
			run: async (j) => {
				ran.push(j.pr)
				if (first) {
					first = false
					throw new Error("boom")
				}
			},
		})
		q.enqueue({ owner: "o", repo: "r", pr: 1 })
		expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("deduped")
		await q.drain()
		expect(ran).toEqual([1, 1])
	})

	test("a deduped re-run cannot starve later PRs or break the concurrency cap", async () => {
		let active = 0,
			peak = 0
		const q = new ReviewQueue({
			concurrency: 2,
			run: async () => {
				active++
				peak = Math.max(peak, active)
				await new Promise((r) => setTimeout(r, 5))
				active--
			},
		})
		q.enqueue({ owner: "o", repo: "r", pr: 1 })
		q.enqueue({ owner: "o", repo: "r", pr: 1 }) // deduped -> re-run
		q.enqueue({ owner: "o", repo: "r", pr: 2 })
		await q.drain()
		expect(peak).toBeLessThanOrEqual(2)
	})

	test("re-runs after the job finished (new head may need a review)", async () => {
		const ran: string[] = []
		const q = new ReviewQueue({
			run: async (j) => {
				ran.push(`${j.repo}#${j.pr}`)
			},
		})
		q.enqueue({ owner: "o", repo: "r", pr: 1 })
		await q.drain()
		expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("queued")
		await q.drain()
		expect(ran.length).toBe(2)
	})

	test("never exceeds the concurrency cap", async () => {
		let active = 0,
			peak = 0
		const q = new ReviewQueue({
			concurrency: 2,
			run: async () => {
				active++
				peak = Math.max(peak, active)
				await new Promise((r) => setTimeout(r, 10))
				active--
			},
		})
		for (let i = 0; i < 6; i++) q.enqueue({ owner: "o", repo: "r", pr: i })
		await q.drain()
		expect(peak).toBeLessThanOrEqual(2)
	})

	test("a failing job does not kill the queue", async () => {
		const ran: number[] = []
		const q = new ReviewQueue({
			run: async (j) => {
				if (j.pr === 1) throw new Error("boom")
				ran.push(j.pr)
			},
		})
		q.enqueue({ owner: "o", repo: "r", pr: 1 })
		q.enqueue({ owner: "o", repo: "r", pr: 2 })
		await q.drain()
		expect(ran).toEqual([2])
	})
})

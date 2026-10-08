// Postgres-backed queue tests.
//
// The behaviour asserted here mirrors the in-memory ReviewQueue suite
// (test/queue.test.ts) case for case, so switching QUEUE_BACKEND cannot change
// what a caller observes: same dedupe key, same concurrency-safe claiming,
// same "a failing job does not kill the queue" — plus the one thing an
// in-process queue cannot offer, surviving a restart.

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { QueueRepository } from "../src/domain/review/queue-repository.ts"
import {
	createQueueRepository,
	queueKeyOf,
} from "../src/infrastructure/db/repositories/queue-repository.ts"
import { createReviewRepository } from "../src/infrastructure/db/repositories/review-repository.ts"
import { createTestDb, type ITestDb } from "./helpers/test-db.ts"

let store: ITestDb
let queue: QueueRepository

beforeEach(async () => {
	store = await createTestDb()
	queue = createQueueRepository(store.db)
})

afterEach(async () => {
	await store.close()
})

describe("db queue — dedupe", () => {
	test("the first enqueue for a key is not deduped", async () => {
		const { job, deduped } = await queue.enqueue({ owner: "o", repo: "r", pr: 1 })
		expect(deduped).toBe(false)
		expect(job.key).toBe("o/r#1")
		expect(job.state).toBe("pending")
		expect(job.attempts).toBe(0)
	})

	test("a second enqueue for the same PR is deduped, not duplicated", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 1 })
		const second = await queue.enqueue({ owner: "o", repo: "r", pr: 1 })
		expect(second.deduped).toBe(true)
		expect(second.job.key).toBe("o/r#1")
		await expect(queue.stats()).resolves.toMatchObject({ pending: 1 })
	})

	test("a re-request while running sets rerunRequested rather than adding a row", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 7 })
		const [claimed] = await queue.claimDue(1)
		expect(claimed?.state).toBe("running")
		expect(claimed?.attempts).toBe(1)

		const again = await queue.enqueue({ owner: "o", repo: "r", pr: 7 })
		expect(again.job.rerunRequested).toBe(true)
		expect(again.job.state).toBe("running")
		await expect(queue.stats()).resolves.toMatchObject({ running: 1 })
	})

	test("different PRs are different jobs", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 1 })
		await queue.enqueue({ owner: "o", repo: "r", pr: 2 })
		await expect(queue.stats()).resolves.toMatchObject({ pending: 2 })
	})
})

describe("db queue — claiming", () => {
	test("claimDue marks claimed jobs running and increments attempts", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 1 })
		const claimed = await queue.claimDue(5)
		expect(claimed).toHaveLength(1)
		expect(claimed[0]?.state).toBe("running")
		expect(claimed[0]?.attempts).toBe(1)
	})

	test("a claimed job is not handed out twice", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 1 })
		await queue.claimDue(5)
		await expect(queue.claimDue(5)).resolves.toHaveLength(0)
	})

	test("claimDue honours its limit and drains in insertion order", async () => {
		for (const pr of [1, 2, 3]) {
			await queue.enqueue({ owner: "o", repo: "r", pr })
		}
		const first = await queue.claimDue(2)
		expect(first.map((j) => j.pr)).toEqual([1, 2])
		const second = await queue.claimDue(2)
		expect(second.map((j) => j.pr)).toEqual([3])
	})
})

describe("db queue — completion", () => {
	test("a clean completion lands in done", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 1 })
		const [job] = await queue.claimDue(1)
		await queue.complete(job?.key ?? "")
		await expect(queue.stats()).resolves.toMatchObject({ done: 1, failed: 0 })
	})

	test("a failure is recorded and does not wedge the queue", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 1 })
		await queue.enqueue({ owner: "o", repo: "r", pr: 2 })
		const [job] = await queue.claimDue(1)
		await queue.complete(job?.key ?? "", "boom")

		await expect(queue.stats()).resolves.toMatchObject({ failed: 1, pending: 1 })
		// the other job is still claimable
		const rest = await queue.claimDue(1)
		expect(rest.map((j) => j.pr)).toEqual([2])
	})
})

describe("db queue — restart survival (the reason this backend exists)", () => {
	test("a job left running by a crash is requeued on boot", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 42 })
		await queue.claimDue(1) // pretend the process died here

		const requeued = await queue.requeueInterrupted()
		expect(requeued).toBe(1)
		await expect(queue.stats()).resolves.toMatchObject({ pending: 1, running: 0 })

		const after = await queue.claimDue(1)
		expect(after.map((j) => j.pr)).toEqual([42])
		expect(after[0]?.attempts).toBe(2)
	})

	test("a pending job at boot is picked up without any reset", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 5 })
		expect(await queue.requeueInterrupted()).toBe(0)
		const claimed = await queue.claimDue(1)
		expect(claimed.map((j) => j.pr)).toEqual([5])
	})

	test("a fresh repository over the same data sees the pending job", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 99 })
		// Simulate the process restarting: same database, brand-new repository.
		const afterRestart = createQueueRepository(store.db)
		expect(await afterRestart.requeueInterrupted()).toBe(0)
		const claimed = await afterRestart.claimDue(1)
		expect(claimed.map((j) => j.key)).toEqual(["o/r#99"])
	})
})

describe("db queue — key parity with the in-memory queue", () => {
	test("queueKeyOf matches the in-memory dedupe key format", () => {
		expect(queueKeyOf("asepharyana", "GMW", 19)).toBe("asepharyana/GMW#19")
	})
})

describe("review repository", () => {
	test("round-trips a review row", async () => {
		const reviews = createReviewRepository(store.db)
		const created = await reviews.insertReview({
			owner: "o",
			repo: "r",
			pr: 3,
			kind: "review",
			status: "success",
			model: "claude-sonnet-5",
			markdown: "## PR Reviewer Guide",
			score: "82/100",
		})
		expect(created.id).toBeGreaterThan(0)
		expect(created.score).toBe("82/100")

		const fetched = await reviews.getReview(created.id)
		expect(fetched?.markdown).toBe("## PR Reviewer Guide")

		const updated = await reviews.updateReview(created.id, { status: "failed", error: "nope" })
		expect(updated?.status).toBe("failed")
		expect(updated?.error).toBe("nope")
	})

	test("listReviews filters by PR and paginates", async () => {
		const reviews = createReviewRepository(store.db)
		for (const pr of [1, 1, 2]) {
			await reviews.insertReview({ owner: "o", repo: "r", pr, status: "success" })
		}
		const page = await reviews.listReviews({ owner: "o", repo: "r", pr: 1 })
		expect(page.total).toBe(2)
		expect(page.rows).toHaveLength(2)

		const limited = await reviews.listReviews({ owner: "o", repo: "r", limit: 1 })
		expect(limited.rows).toHaveLength(1)
		expect(limited.total).toBe(3)
	})

	test("listReports an empty page rather than throwing", async () => {
		const reviews = createReviewRepository(store.db)
		const page = await reviews.listReviews({ limit: 10_000 })
		expect(page.total).toBe(0)
	})
})

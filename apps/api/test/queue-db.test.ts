// Postgres-backed queue tests.
//
// The behaviour asserted here mirrors the in-memory ReviewQueue suite
// (test/queue.test.ts) case for case, so switching QUEUE_BACKEND cannot change
// what a caller observes: same dedupe key, same concurrency-safe claiming,
// same "a failing job does not kill the queue" — plus the one thing an
// in-process queue cannot offer, surviving a restart.

import { sql } from "drizzle-orm"
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

	test("complete() reports no rerun when nothing landed mid-flight", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 8 })
		const [claimed] = await queue.claimDue(1)
		expect(claimed?.state).toBe("running")
		const settled = await queue.complete("o/r#8")
		expect(settled.rerun).toBe(false)
		await expect(queue.stats()).resolves.toMatchObject({ done: 1, pending: 0 })
	})

	test("a webhook that lands mid-review puts the job back on pending", async () => {
		// `rerunRequested` used to be written and never read: the flag was set
		// here, then cleared by complete() on the way out, and claimDue only ever
		// selected `pending` — so the coalesced re-run the schema promised never
		// happened and a push during a review was dropped.
		await queue.enqueue({ owner: "o", repo: "r", pr: 9 })
		await queue.claimDue(1)

		const again = await queue.enqueue({ owner: "o", repo: "r", pr: 9 })
		expect(again.deduped).toBe(true)
		expect(again.job.rerunRequested).toBe(true)

		const settled = await queue.complete("o/r#9")
		expect(settled.rerun).toBe(true)
		// Re-armed, not merely recorded: claimable again right now.
		await expect(queue.stats()).resolves.toMatchObject({ pending: 1, done: 0 })
		const [rerun] = await queue.claimDue(1)
		expect(rerun?.attempts).toBe(2)
	})

	test("a FAILED job is not re-armed by a coalesced rerun", async () => {
		// The error is the fresher fact: replaying the same failing review
		// immediately would hide it. `enqueue` re-arms a failed row on the next
		// webhook, which is the correct recovery.
		await queue.enqueue({ owner: "o", repo: "r", pr: 10 })
		await queue.claimDue(1)
		await queue.enqueue({ owner: "o", repo: "r", pr: 10 })

		const settled = await queue.complete("o/r#10", "boom")
		expect(settled.rerun).toBe(false)
		await expect(queue.stats()).resolves.toMatchObject({ failed: 1, pending: 0 })
	})

	test("a collapsing burst of re-requests coalesces into ONE rerun", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 11 })
		await queue.claimDue(1)
		for (let i = 0; i < 5; i++) await queue.enqueue({ owner: "o", repo: "r", pr: 11 })

		await queue.complete("o/r#11")
		// One pending row, not five.
		await expect(queue.stats()).resolves.toMatchObject({ pending: 1 })
	})

	test("different PRs are different jobs", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 1 })
		await queue.enqueue({ owner: "o", repo: "r", pr: 2 })
		await expect(queue.stats()).resolves.toMatchObject({ pending: 2 })
	})

	// A `failed` row means a review THREW, not that the PR was decided. The
	// conflict clause used to leave every terminal row alone, so a failed review
	// was unrecoverable: claimDue only selects `pending`, so the row could never
	// run again no matter how often the webhook fired or how often the cause was
	// fixed. Re-enqueue must re-arm it — this is what made the YAML parse bug
	// permanent even after the parse was fixed.
	test("re-enqueueing a FAILED job re-arms it so the review can be retried", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 7 })
		const [job] = await queue.claimDue(1)
		await queue.complete(job?.key ?? "", "All models failed: boom")
		await expect(queue.stats()).resolves.toMatchObject({ failed: 1 })

		const again = await queue.enqueue({ owner: "o", repo: "r", pr: 7 })
		expect(again.job.state).toBe("pending")
		// The stale error must not survive: it describes a run that is now pending.
		expect(again.job.lastError).toBeNull()
		// CRITICAL: not deduped, or db-review-queue skips pump() and the row sits
		// pending until something else claims it.
		expect(again.deduped).toBe(false)

		const claimed = await queue.claimDue(1)
		expect(claimed.map((j) => j.pr)).toEqual([7])
		expect(claimed[0]?.attempts).toBe(2)
	})

	test("re-enqueueing a DONE job stays deduped — a reviewed PR is not reviewed twice", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 8 })
		const [job] = await queue.claimDue(1)
		await queue.complete(job?.key ?? "")
		await expect(queue.stats()).resolves.toMatchObject({ done: 1 })

		const again = await queue.enqueue({ owner: "o", repo: "r", pr: 8 })
		expect(again.deduped).toBe(true)
		expect(again.job.state).toBe("done")
		// A re-armed row is old by definition, so `createdAt < now` must not be the
		// dedupe test — it would read a retry as deduped and silently drop it.
		await expect(queue.claimDue(1)).resolves.toHaveLength(0)
	})

	// THE DEDUPE VERDICT MUST NOT BE INFERRED FROM A CLOCK COMPARISON.
	//
	// `existed` used to be `createdAt < now`: `now` is the JS date that went into
	// the INSERT, `created_at` comes back from the server, and on the production
	// driver the two disagree by +0..5ms for a row that was just INSERTED
	// (measured against node-postgres on this box: deltas 5,0,1,1). The old
	// verdict then called a fresh insert a re-request, `db-review-queue` skipped
	// `pump()`, and the review waited for something else to claim the row.
	//
	// PGlite makes that delta 0, so the bug cannot be reproduced by racing the
	// clocks here — asserting on a fresh enqueue passes under sabotage. What CAN
	// be pinned is the invariant the fix exists for: a first enqueue answers
	// `deduped:false` AND its row is due immediately, which is the contract the
	// pump depends on.
	test("a first enqueue is claimable immediately, not deduped", async () => {
		for (const pr of [21, 22, 23, 24, 25]) {
			const { deduped, job } = await queue.enqueue({ owner: "o", repo: "r", pr })
			expect(deduped).toBe(false)
			expect(job.state).toBe("pending")
			// If the verdict were wrong this deadline would be irrelevant — the
			// row would sit unclaimed until an unrelated webhook arrived.
			expect(job.runAfter.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
		}
		await expect(queue.claimDue(5)).resolves.toHaveLength(5)
	})

	// ACCEPTING A DELIVERY AND THEN IGNORING IT IS THE WORST ANSWER.
	//
	// A `pending` row whose `run_after` is in the future (a re-arm, a probe, a
	// provider backoff) used to keep that deadline on a re-request: the webhook
	// answered `{triggered:true}` and the row did not move. The re-request is
	// the newer fact, so it wins.
	test("a re-request pulls a future run_after back to NOW", async () => {
		const { job } = await queue.enqueue({ owner: "o", repo: "r", pr: 30 })
		await store.db.execute(
			sql`update review_queue_jobs set run_after = now() + interval '1 hour' where key = ${job.key}`,
		)
		await expect(queue.claimDue(1)).resolves.toHaveLength(0) // not due yet

		const again = await queue.enqueue({ owner: "o", repo: "r", pr: 30 })
		expect(again.deduped).toBe(true)
		expect(again.job.runAfter.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
		await expect(queue.claimDue(1)).resolves.toHaveLength(1)
	})

	// A REQUESTED RE-RUN THAT NEVER RUNS IS A SILENT DROP.
	//
	// The flag used to be cleared by every `complete()`, on every arm, including
	// the failing one. A webhook that arrived before the row was claimed — the
	// ordinary case, since a delivery usually precedes the next poll — was
	// therefore erased by the completion of the FIRST run, and `triggered:true`
	// bought nothing.
	test("a re-request recorded while the job was still pending survives the run", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 31 })
		const mid = await queue.enqueue({ owner: "o", repo: "r", pr: 31 })
		expect(mid.job.rerunRequested).toBe(true)

		const [claimed] = await queue.claimDue(1)
		const settled = await queue.complete(claimed?.key ?? "o/r#31")
		expect(settled.rerun).toBe(true)
		await expect(queue.stats()).resolves.toMatchObject({ pending: 1, done: 0 })
	})

	test("a re-request recorded before a FAILING run is kept, not erased with the error", async () => {
		await queue.enqueue({ owner: "o", repo: "r", pr: 32 })
		await queue.enqueue({ owner: "o", repo: "r", pr: 32 })
		const [claimed] = await queue.claimDue(1)
		const settled = await queue.complete(claimed?.key ?? "o/r#32", "boom")
		expect(settled.rerun).toBe(false)
		await expect(queue.stats()).resolves.toMatchObject({ failed: 1 })

		// The flag is still SET, which is the whole point: every `complete()` used
		// to clear it, so this request died with the error. The row is `failed`
		// and the request rides it until `enqueue` re-arms it to `pending`, which
		// is the recovery path for a thrown review.
		const row = await store.db.execute(
			sql`select state, rerun_requested from review_queue_jobs where key = ${"o/r#32"}`,
		)
		expect(row.rows[0]).toMatchObject({ state: "failed", rerun_requested: true })
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

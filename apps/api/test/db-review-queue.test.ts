import { describe, expect, test, vi } from "vitest"
import type { QueueRepository, TQueueJob } from "../src/domain/review/queue-repository.ts"
import { makeDbReviewQueue } from "../src/infrastructure/queue/db-review-queue.ts"

const job: TQueueJob = {
	id: 1,
	key: "o/r#1",
	owner: "o",
	repo: "r",
	pr: 1,
	state: "running",
	attempts: 1,
	headSha: null,
	rerunRequested: false,
	runAfter: new Date(),
	lastError: null,
	createdAt: new Date(),
	updatedAt: new Date(),
}

describe("DB queue completion recovery", () => {
	for (const fails of [false, true]) {
		test(`retries persistence without replaying a ${fails ? "failed" : "successful"} review`, async () => {
			vi.useFakeTimers()
			try {
				let completed = false
				const complete = vi
					.fn<QueueRepository["complete"]>()
					.mockRejectedValueOnce(new Error("database offline"))
					.mockRejectedValueOnce(new Error("database offline"))
					.mockImplementation(async () => {
						completed = true
						return { rerun: false }
					})
				const store: QueueRepository = {
					enqueue: async () => ({ job, deduped: false }),
					claimDue: vi
						.fn<QueueRepository["claimDue"]>()
						.mockResolvedValueOnce([job])
						.mockResolvedValue([]),
					complete,
					requeueInterrupted: async () => 0,
					stats: async () => ({
						pending: 0,
						running: completed ? 0 : 1,
						done: completed && !fails ? 1 : 0,
						failed: completed && fails ? 1 : 0,
					}),
				}
				const run = vi.fn(async () => {
					if (fails) throw new Error("review failed")
				})
				// Even an unavailable logger must not interrupt persistence recovery.
				const queue = makeDbReviewQueue({
					store,
					concurrency: 1,
					run,
					pollIntervalMs: 10,
					log: () => {
						throw new Error("logger offline")
					},
				})
				await queue.enqueue({ owner: job.owner, repo: job.repo, pr: job.pr })
				await vi.advanceTimersByTimeAsync(1)
				expect(complete).toHaveBeenCalledTimes(1)
				expect(run).toHaveBeenCalledTimes(1)
				const drained = queue.drain()
				await vi.advanceTimersByTimeAsync(40)
				await drained
				expect(complete).toHaveBeenCalledTimes(3)
				expect(complete).toHaveBeenLastCalledWith(job.key, fails ? "Error: review failed" : null)
				expect(run).toHaveBeenCalledTimes(1)
				expect(await queue.stats()).toMatchObject({
					running: 0,
					done: fails ? 0 : 1,
					failed: fails ? 1 : 0,
				})
			} finally {
				vi.useRealTimers()
			}
		})
	}
})

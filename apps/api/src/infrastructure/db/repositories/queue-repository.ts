// Drizzle adapter for QueueRepository.
//
// Two behaviours carry over from the in-memory ReviewQueue and must not drift:
//   - enqueue() on an existing key does not insert a duplicate; it flags
//     rerunRequested so a running job re-runs once it settles.
//   - a job that fails is still completed, so one bad PR cannot wedge the
//     queue (the in-memory queue logs and moves on; so does this).

import { and, asc, count, eq, inArray, lte, sql } from "drizzle-orm"
import type { PgDatabase } from "drizzle-orm/pg-core"
import type {
	QueueRepository,
	TEnqueueInput,
	TQueueJob,
	TQueueStats,
} from "../../../domain/review/queue-repository.ts"
import { reviewQueueJobs } from "../schema.ts"

export const queueKeyOf = (owner: string, repo: string, pr: number): string =>
	`${owner}/${repo}#${pr}`

const toJob = (row: typeof reviewQueueJobs.$inferSelect): TQueueJob => ({
	id: row.id,
	key: row.key,
	owner: row.owner,
	repo: row.repo,
	pr: row.pr,
	state: row.state,
	attempts: row.attempts,
	rerunRequested: row.rerunRequested,
	runAfter: row.runAfter,
	lastError: row.lastError,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

/**
 * Generic over the driver for the same reason as createReviewRepository:
 * production passes the node-postgres handle, the integration tests pass the
 * in-memory pglite one, and only the session result types differ.
 */
export function createQueueRepository<TDb extends PgDatabase<any, any>>(db: TDb): QueueRepository {
	return {
		async enqueue(input: TEnqueueInput) {
			const key = queueKeyOf(input.owner, input.repo, input.pr)
			const now = new Date()

			const inserted = await db
				.insert(reviewQueueJobs)
				.values({ ...input, key, state: "pending", runAfter: now })
				.onConflictDoUpdate({
					// Only a live job can absorb a re-request; a terminal row is
					// left alone so the recorded outcome stays accurate.
					//
					// Raw SQL on purpose: interpolating a Drizzle column into a
					// `sql` template turns it into a *bound parameter*, which is
					// illegal in this position — Drizzle emitted "do update set
					// returning" and dropped the clause entirely. The column names
					// below are literals matching this file's own schema.
					target: reviewQueueJobs.key,
					set: {
						rerunRequested: sql`(
							CASE
								WHEN "review_queue_jobs"."state" IN ('pending', 'running')
									THEN true
								ELSE "review_queue_jobs"."rerun_requested"
							END
						)`,
					},
				})
				.returning()

			const row = inserted[0]
			if (!row) throw new Error("enqueue returned no row")
			return { job: toJob(row), deduped: row.createdAt < now }
		},

		async claimDue(limit: number): Promise<TQueueJob[]> {
			const now = new Date()
			return db.transaction(async (tx) => {
				const due = await tx
					.select()
					.from(reviewQueueJobs)
					.where(and(eq(reviewQueueJobs.state, "pending"), lte(reviewQueueJobs.runAfter, now)))
					.orderBy(asc(reviewQueueJobs.runAfter), asc(reviewQueueJobs.id))
					.limit(limit)
					.for("update", { skipLocked: true })

				if (due.length === 0) return []

				const ids = due.map((d) => d.id)
				const claimed = await tx
					.update(reviewQueueJobs)
					.set({
						state: "running",
						updatedAt: now,
						attempts: sql`${reviewQueueJobs.attempts} + 1`,
					})
					.where(inArray(reviewQueueJobs.id, ids))
					.returning()

				return claimed.map(toJob)
			})
		},

		async complete(key: string, error?: string | null): Promise<void> {
			await db
				.update(reviewQueueJobs)
				.set({
					state: error ? "failed" : "done",
					lastError: error ?? null,
					rerunRequested: false,
					updatedAt: new Date(),
				})
				.where(eq(reviewQueueJobs.key, key))
		},

		async requeueInterrupted(): Promise<number> {
			const requeued = await db
				.update(reviewQueueJobs)
				.set({ state: "pending", updatedAt: new Date() })
				.where(eq(reviewQueueJobs.state, "running"))
				.returning({ id: reviewQueueJobs.id })
			return requeued.length
		},

		async stats(): Promise<TQueueStats> {
			const rows = await db
				.select({ state: reviewQueueJobs.state, value: count() })
				.from(reviewQueueJobs)
				.groupBy(reviewQueueJobs.state)

			const out: TQueueStats = { pending: 0, running: 0, done: 0, failed: 0 }
			for (const row of rows) out[row.state as keyof TQueueStats] = row.value
			return out
		},
	}
}

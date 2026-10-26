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
	TCompleteResult,
	TEnqueueInput,
	TQueueJob,
	TQueueStats,
} from "../../../domain/review/queue-repository.ts"
import { reviewQueueJobs } from "../schema.ts"

/**
 * The query surface a repository needs, generic over the driver.
 *
 * PgDatabase's first generic is the driver's query-result type, which differs
 * between the node-postgres handle production uses and the pglite handle the
 * integration tests use. `unknown` is not accepted there, so this alias holds
 * the single unavoidable `any` rather than repeating it at each use site.
 */
// biome-ignore lint/suspicious/noExplicitAny: documented above
export type TAnyPgDatabase = PgDatabase<any, any>

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
export function createQueueRepository<TDb extends TAnyPgDatabase>(db: TDb): QueueRepository {
	return {
		async enqueue(input: TEnqueueInput) {
			const key = queueKeyOf(input.owner, input.repo, input.pr)
			const now = new Date()

			// `.returning(...)` MUST come BEFORE `.onConflictDoUpdate(...)`, not
			// after it. Drizzle resolves a projected `returning` against the
			// insert's own value map, and a column that is not in it (this
			// `xmax`) silently poisons the merged plan: the statement goes out
			// as a plain INSERT with no `ON CONFLICT`, every re-enqueue throws
			// 23505, and `.returning()` placed after the conflict clause is a
			// type error outright. Measured: 7 red tests.
			const inserted = await db
				.insert(reviewQueueJobs)
				.values({ ...input, key, state: "pending", runAfter: now })
				.returning({
					id: reviewQueueJobs.id,
					key: reviewQueueJobs.key,
					owner: reviewQueueJobs.owner,
					repo: reviewQueueJobs.repo,
					pr: reviewQueueJobs.pr,
					state: reviewQueueJobs.state,
					attempts: reviewQueueJobs.attempts,
					rerunRequested: reviewQueueJobs.rerunRequested,
					runAfter: reviewQueueJobs.runAfter,
					lastError: reviewQueueJobs.lastError,
					createdAt: reviewQueueJobs.createdAt,
					updatedAt: reviewQueueJobs.updatedAt,
					// 0 for a row THIS statement inserted, non-zero when the
					// conflict clause updated an existing one. Not part of the
					// domain row, so `toJob` ignores it.
					xmax: sql<number>`xmax`,
				})
				.onConflictDoUpdate({
					// Only a live job can absorb a re-request; a `done` row is left
					// alone so the recorded outcome stays accurate and an
					// already-reviewed PR is not reviewed twice.
					//
					// A `failed` row MUST be re-armed, though, and not left alone: the
					// comment's "terminal row is left alone" rule was written as if
					// `failed` meant "decided". It does not — it means a review threw.
					// Leaving it terminal meant a PR whose review failed could never be
					// reviewed again, no matter how many times the webhook fired or how
					// many times the cause was fixed: `claimDue` only selects `pending`,
					// so the row was dead forever. That is what made the YAML parse bug
					// unrecoverable — after fixing it, PR #7 still refused to enqueue.
					//
					// Raw SQL on purpose: interpolating a Drizzle column into a
					// `sql` template turns it into a *bound parameter*, which is
					// illegal in this position — Drizzle emitted "do update set
					// returning" and dropped the clause entirely. The column names
					// below are literals matching this file's own schema.
					target: reviewQueueJobs.key,
					set: {
						state: sql`(CASE WHEN "review_queue_jobs"."state" = 'failed' THEN 'pending' ELSE "review_queue_jobs"."state" END)`,
						// The old error described a run that has not been retried; keeping
						// it would make a job that is pending look failed in every report.
						lastError: sql`(CASE WHEN "review_queue_jobs"."state" = 'failed' THEN NULL ELSE "review_queue_jobs"."last_error" END)`,
						// Re-queue it for NOW when it is RE-ARMED (failed), and also when a
						// re-request lands on a `pending` row whose deadline is still in the
						// future. Accepting such a webhook and then leaving the old deadline
						// made the delivery a no-op: `triggered: true`, row untouched.
						runAfter: sql`(CASE WHEN "review_queue_jobs"."state" = 'failed' OR ("review_queue_jobs"."state" = 'pending' AND "review_queue_jobs"."run_after" > now()) THEN now() ELSE "review_queue_jobs"."run_after" END)`,
						rerunRequested: sql`(
							CASE
								WHEN "review_queue_jobs"."state" IN ('pending', 'running')
									THEN true
								ELSE "review_queue_jobs"."rerun_requested"
							END
						)`,
					},
				})

			const row = inserted[0]
			if (!row) throw new Error("enqueue returned no row")
			// WHAT THE CONFLICT CLAUSE ITSELF DID, never the row's age.
			//
			// The verdict used to be `existed && !reArmed`, where `existed` was
			// `createdAt < now`: a JS clock compared against a timestamp the
			// DATABASE stamped. `now` is truncated to the second on the way in
			// and `created_at` comes back at microsecond precision, so for a
			// brand-new row `createdAt > now` — `existed` was TRUE for a row
			// this very statement had just INSERTED. The enqueue then answered
			// `deduped`, `db-review-queue` skipped `pump()`, and the review
			// waited for something else to claim the row. A `pending` row whose
			// `run_after` was still in the future could not be re-armed at all.
			//
			// `xmax = 0` is the engine's own answer to "did this statement
			// insert, or did it conflict and update?", decided inside the same
			// statement. The conflict clause sets `state` to exactly `'pending'`
			// and clears `rerun_requested` only on the arms that are NOT live
			// re-requests, so those two fields are what the clause reported.
			const insertedFresh = Number((row as { xmax?: number }).xmax ?? 0) === 0
			const reArmed = row.state === "pending" && !row.rerunRequested
			return { job: toJob(row), deduped: !insertedFresh && !reArmed }
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

		async complete(key: string, error?: string | null): Promise<TCompleteResult> {
			// A COALESCED RE-RUN IS RESOLVED HERE, not in `claimDue`.
			//
			// `rerunRequested` used to be WRITTEN and never READ. The conflict clause
			// set it when a webhook landed on a running job, `complete()` then cleared
			// it on the way out, and `claimDue` only ever selected `pending` — so the
			// re-run it promised never happened. Probed against a live PGlite store:
			// a re-enqueue mid-review answered `deduped` and `run()` was invoked ONCE
			// where the in-memory queue invokes it TWICE. A push that landed during a
			// review was dropped, and the PR kept its comment for the OLD head.
			//
			// Settling is the only correct place to decide this: it is the moment the
			// job stops being `running`, and it is the same place the in-memory queue
			// re-queues (`review-queue.ts` pushes the job back onto `pending` in its
			// `finally`). Doing it in `claimDue` instead would be dead code, because
			// this method has already cleared the flag by then.
			//
			// A FAILED job is NOT re-armed. The error is the fresher fact: retrying the
			// same PR immediately would replay the failure the operator needs to see,
			// and `enqueue` already re-arms a `failed` row when the next webhook
			// arrives. Re-arming here too would double-run it.
			const settled = await db.transaction(async (tx) => {
				const current = await tx
					.select({ rerun: reviewQueueJobs.rerunRequested, state: reviewQueueJobs.state })
					.from(reviewQueueJobs)
					.where(eq(reviewQueueJobs.key, key))
					.for("update")
					.limit(1)

				// A REQUEST FOR A JOB THAT NEVER RAN IS STILL A REQUEST.
				//
				// The flag is only consulted when the job SUCCEEDED, and it used
				// to be cleared unconditionally at the end of this method. So a
				// webhook that arrived before the row was claimed — which is the
				// normal case, since a delivery usually precedes the next poll —
				// set `rerun_requested`, and the very next `complete()` wiped it
				// without ever reading it. The re-request vanished: `triggered:
				// true` in the response, no second review, and the failure is
				// invisible because the row ends `done`.
				//
				// Here: on success, `pending`/`running` with the flag means re-arm;
				// on FAILURE the flag is KEPT, so a re-request that landed during a
				// failing run survives for the next claim instead of being erased
				// with the error that describes it.
				const rerun =
					current[0]?.rerun === true &&
					!error &&
					(current[0]?.state === "pending" || current[0]?.state === "running")

				await tx
					.update(reviewQueueJobs)
					.set({
						state: error ? "failed" : rerun ? "pending" : "done",
						lastError: error ?? null,
						rerunRequested: error ? (current[0]?.rerun ?? false) : false,
						// A re-armed row is claimable NOW; otherwise the timestamp is
						// left alone, exactly as before.
						...(rerun ? { runAfter: new Date() } : {}),
						updatedAt: new Date(),
					})
					.where(eq(reviewQueueJobs.key, key))

				return { rerun }
			})
			return settled
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

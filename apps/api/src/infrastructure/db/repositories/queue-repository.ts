// Drizzle adapter for QueueRepository.
//
// Three behaviours carry over from the in-memory ReviewQueue and must not drift:
//   - enqueue() on an existing key does not insert a duplicate; it flags
//     rerunRequested so a running job re-runs once it settles.
//   - enqueue() RE-ARMS a finished job when the delivery names a new head
//     commit, because a push after a review is new work. The same commit (or a
//     delivery with no SHA) is still deduped.
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
	headSha: row.headSha,
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

			// THE PRIOR STATE, READ BEFORE THE UPSERT — for the verdict only.
			//
			// `RETURNING` cannot see the row as it was. That was tolerable while a
			// re-request on a live row always set `rerun_requested`, because the
			// post-update shape then identified what the statement had done. It is
			// not tolerable now: a same-commit duplicate is a no-op, so
			// `state = 'pending' AND rerun_requested = false` is produced by BOTH
			// "re-armed, work to do" and "duplicate delivery, nothing to do", and
			// the two must not report the same verdict.
			//
			// The upsert below is still the single atomic source of truth for the
			// state transition; this read only answers "did this delivery create
			// work?". If a concurrent enqueue races it, the worst outcome is a
			// mislabelled verdict — never a wrong state.
			const prior =
				(
					await db
						.select({ state: reviewQueueJobs.state })
						.from(reviewQueueJobs)
						.where(eq(reviewQueueJobs.key, key))
						.limit(1)
				)[0] ?? null

			// `.returning(...)` MUST come BEFORE `.onConflictDoUpdate(...)`, not
			// after it. Drizzle resolves a projected `returning` against the
			// insert's own value map, and a column that is not in it (this
			// `xmax`) silently poisons the merged plan: the statement goes out
			// as a plain INSERT with no `ON CONFLICT`, every re-enqueue throws
			// 23505, and `.returning()` placed after the conflict clause is a
			// type error outright. Measured: 7 red tests.
			const inserted = await db
				.insert(reviewQueueJobs)
				.values({
					...input,
					key,
					state: "pending",
					runAfter: now,
					// Explicit, so a caller that omits the SHA cannot leave the
					// column undefined on the insert path.
					headSha: input.headSha ?? null,
				})
				.returning({
					id: reviewQueueJobs.id,
					key: reviewQueueJobs.key,
					owner: reviewQueueJobs.owner,
					repo: reviewQueueJobs.repo,
					pr: reviewQueueJobs.pr,
					state: reviewQueueJobs.state,
					attempts: reviewQueueJobs.attempts,
					headSha: reviewQueueJobs.headSha,
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
					// A RE-REQUEST ONLY RE-ARMS A TERMINAL ROW WHEN THERE IS NEW
					// WORK. Three cases, and the third is the one that was
					// missing:
					//
					//   - `failed`: re-arm. The comment's old "terminal row is
					//     left alone" rule was written as if `failed` meant
					//     "decided". It does not — it means a review threw.
					//     Leaving it terminal meant a PR whose review failed
					//     could never be reviewed again, no matter how often the
					//     webhook fired or the cause was fixed: `claimDue` only
					//     selects `pending`, so the row was dead forever. That is
					//     what made the YAML parse bug unrecoverable.
					//
					//   - `done` + a DIFFERENT head SHA: re-arm. A `done` row was
					//     terminal for every delivery, so a push after a review
					//     was never reviewed: the webhook deduped against a row
					//     that had already finished, and only the in-memory queue
					//     (which keeps no history) re-ran. Production is the DB
					//     backend, so a PR's second commit could go unreviewed
					//     forever while development looked fine.
					//
					//   - `done` + the SAME head SHA (or no SHA on the delivery):
					//     leave it. That is the original intent — an
					//     already-reviewed commit is not reviewed twice, and a
					//     redelivered webhook costs nothing.
					//
					// Raw SQL on purpose: interpolating a Drizzle column into a
					// `sql` template turns it into a *bound parameter*, which is
					// illegal in this position — Drizzle emitted "do update set
					// returning" and dropped the clause entirely. The column
					// names below are literals matching this file's own schema.
					target: reviewQueueJobs.key,
					set: {
						state: sql`(
							CASE
								WHEN "review_queue_jobs"."state" = 'failed' THEN 'pending'
								WHEN "review_queue_jobs"."state" = 'done'
									AND excluded."head_sha" IS NOT NULL
									AND "review_queue_jobs"."head_sha" IS DISTINCT FROM excluded."head_sha"
									THEN 'pending'
								ELSE "review_queue_jobs"."state"
							END
						)`,
						// The old error described a run that has not been retried; keeping
						// it would make a job that is pending look failed in every report.
						lastError: sql`(
							CASE
								WHEN "review_queue_jobs"."state" = 'failed' THEN NULL
								WHEN "review_queue_jobs"."state" = 'done'
									AND excluded."head_sha" IS NOT NULL
									AND "review_queue_jobs"."head_sha" IS DISTINCT FROM excluded."head_sha"
									THEN NULL
								ELSE "review_queue_jobs"."last_error"
							END
						)`,
						// Re-queue it for NOW when it is RE-ARMED (failed, or a done row
						// with a new commit), and also when a re-request lands on a
						// `pending` row whose deadline is still in the future. Accepting
						// such a webhook and then leaving the old deadline made the
						// delivery a no-op: `triggered: true`, row untouched.
						runAfter: sql`(
							CASE
								WHEN "review_queue_jobs"."state" = 'failed' THEN now()
								WHEN "review_queue_jobs"."state" = 'done'
									AND excluded."head_sha" IS NOT NULL
									AND "review_queue_jobs"."head_sha" IS DISTINCT FROM excluded."head_sha"
									THEN now()
								WHEN "review_queue_jobs"."state" = 'pending'
									AND "review_queue_jobs"."run_after" > now()
									THEN now()
								ELSE "review_queue_jobs"."run_after"
							END
						)`,
						// The newest delivery is the fresher fact: a re-request during a
						// run must be judged against the commit it named.
						headSha: sql`COALESCE(excluded."head_sha", "review_queue_jobs"."head_sha")`,
						// `attempts` counts attempts at the CURRENT unit of work, so a
						// re-arm restarts it. Left alone it climbed monotonically across
						// every commit a PR ever pushed (probed: 1→6 over six commits),
						// which would turn any future retry ceiling (`attempts < N`) into
						// a permanent wedge on a long-lived PR — exactly the "row is dead
						// forever" trap the `failed` arm above exists to undo.
						attempts: sql`(
							CASE
								WHEN "review_queue_jobs"."state" = 'failed' THEN 0
								WHEN "review_queue_jobs"."state" = 'done'
									AND excluded."head_sha" IS NOT NULL
									AND "review_queue_jobs"."head_sha" IS DISTINCT FROM excluded."head_sha"
									THEN 0
								ELSE "review_queue_jobs"."attempts"
							END
						)`,
						// A re-request only earns a SECOND RUN when one could otherwise
						// be lost: the job is `running` (its review already read the
						// head, so a push now is invisible to it) and the delivery names
						// a different commit. Two bugs in one arm:
						//
						//   - It was unconditional, so a redelivered webhook (GitHub
						//     retries; the worker re-sends the same head on every tick
						//     until a review appears) queued a second full LLM review of
						//     an identical commit — the exact cost the `head_sha` column
						//     exists to remove — while the response said `deduped: true`.
						//
						//   - It also fired for `pending`, where it is useless AND
						//     harmful: that row has not started, so its review reads the
						//     head as it is when it runs (`head_sha` is coalesced to the
						//     newest delivery above) and nothing can be missed. Flagging
						//     it made `complete()` re-arm the row afterwards, so a
						//     duplicate delivery bought a second review of the commit the
						//     first run had just finished.
						//
						// `NULL` on either side keeps the flag for a `running` row: with
						// no SHA there is no way to prove it is the same work, and
						// dropping it could lose a real push.
						rerunRequested: sql`(
							CASE
								WHEN "review_queue_jobs"."state" = 'running'
									AND (
										excluded."head_sha" IS NULL
										OR "review_queue_jobs"."head_sha" IS NULL
										OR "review_queue_jobs"."head_sha" IS DISTINCT FROM excluded."head_sha"
									)
									THEN true
								ELSE "review_queue_jobs"."rerun_requested"
							END
						)`,
					},
				})

			const row = inserted[0]
			if (!row) throw new Error("enqueue returned no row")
			// WHAT THE CONFLICT CLAUSE DID, never the row's age.
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
			// statement — so the insert case needs no inference at all.
			const insertedFresh = Number((row as { xmax?: number }).xmax ?? 0) === 0
			if (insertedFresh) return { job: toJob(row), deduped: false }

			// A delivery counts as NEW WORK when the statement either moved a
			// terminal row back to `pending` (so it is claimable again) or flagged a
			// coalesced re-run on a running one. Reading both signals off the row
			// the statement returned is what keeps the verdict honest: it used to
			// answer `deduped: true` for a delivery that `complete()` then re-ran,
			// i.e. the exact opposite of what happened.
			//
			// `prior === null` only happens if a concurrent enqueue inserted the row
			// between the read and the upsert; the transition itself is still
			// correct, and the worst outcome is a mislabelled verdict.
			const reArmed =
				prior !== null &&
				prior.state !== "pending" &&
				prior.state !== "running" &&
				row.state === "pending"
			const flaggedRerun = row.rerunRequested === true

			return { job: toJob(row), deduped: !reArmed && !flaggedRerun }
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

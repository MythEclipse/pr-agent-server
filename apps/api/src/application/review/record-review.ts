// Record a review's life in the history table.
//
// WHY THIS EXISTS. `reviews` is the table the dashboard reads, and NOTHING WROTE
// TO IT. Measured on the live database: 88 rows in `review_queue_jobs` with
// state='done' and ZERO rows in `reviews` — so every review the system had ever
// run was invisible in the UI, and the list page's "No reviews yet." was
// accurate and permanent. The queue recorded that work happened; the history of
// what was said was never stored.
//
// THREE STATES, EACH WRITTEN BY THE MOMENT IT DESCRIBES:
//
//   `queued`   when a delivery creates work (webhook → `enqueue`). This is what
//              "waiting in the queue" means, and it is the only state in which a
//              row is allowed to have no `startedAt`.
//   `running`  when the queue hands the job to `runJob` (`start`), which flips
//              the queued row rather than inserting a second one.
//   `success` / `failed`  at `finish`.
//
// BEFORE THIS, `start` inserted the row as `queued` and nothing ever wrote
// `running`: the status existed in the schema, in the API's enum and in the
// dashboard's filter buttons, and no row could ever carry it. Meanwhile the
// `queued` filter listed rows that were executing, and — measured on the live
// database, 9 of them — rows whose process had died days earlier and whose
// `finished_at` stayed NULL forever. Both filters were lies in opposite
// directions.

import type { TReviewStatus } from "../../domain/review/review.ts"
import type { ReviewRepository } from "../../domain/review/review-repository.ts"

export interface RecordReviewStartInput {
	owner: string
	repo: string
	pr: number
	kind?: "review" | "describe" | "improve"
}

export interface RecordReviewFinishInput {
	owner: string
	repo: string
	pr: number
	status: Extract<TReviewStatus, "success" | "failed">
	/** The model we ASKED for, after any fallback. */
	model?: string
	/**
	 * The model the endpoint reported it actually served.
	 *
	 * Recorded alongside `model` because they disagree on this deployment: the
	 * gateway answers a request for `claude-sonnet-5` with `cat-jam-free`. When
	 * present this is the honest attribution and should be preferred for
	 * display; `model` remains what was requested.
	 */
	servedModel?: string
	/** Rendered review markdown, as published to GitHub. */
	markdown?: string
	/** Extracted from the model's YAML. */
	score?: string | number | null
	error?: string | null
	headSha?: string | null
}

export interface RecordReviewDeps {
	reviews: ReviewRepository
	/** Injected so a test can pin the clock; defaults to the wall clock. */
	now?: () => Date
}

/**
 * The score, as the model reported it, or null.
 *
 * The column is TEXT on purpose (the prompt may emit "8", "8/10" or "85%"), so
 * this only has to survive the round-trip — but it does have to reach the column
 * as a string, and `String(undefined)` would store the literal "undefined".
 */
const scoreOf = (data: Record<string, unknown> | null): string | null => {
	const review = data?.review
	if (review === null || typeof review !== "object") return null
	const raw = (review as Record<string, unknown>).score
	if (raw === undefined || raw === null || raw === "") return null
	return String(raw)
}

export function makeRecordReview(deps: RecordReviewDeps) {
	const now = deps.now ?? (() => new Date())

	return {
		/**
		 * Insert the `queued` row for a delivery that created work.
		 *
		 * `startedAt` is deliberately NOT set: the review has not started. The
		 * dashboard reads that absence as "waiting", and `start()` fills it in
		 * when the queue hands the job over — which is also what makes the
		 * duration on the detail page measure the RUN, not the wait.
		 */
		async enqueue(input: RecordReviewStartInput): Promise<number | null> {
			try {
				const row = await deps.reviews.insertReview({
					owner: input.owner,
					repo: input.repo,
					pr: input.pr,
					kind: input.kind ?? "review",
					status: "queued",
					startedAt: null,
				})
				return row.id
			} catch (err) {
				console.error(
					`[history] failed to queue review row for ${input.owner}/${input.repo}#${input.pr}:`,
					err,
				)
				return null
			}
		},

		/**
		 * Mark the review RUNNING: flip the queued row this job belongs to, or
		 * insert a `running` row when there is none (a job re-armed from `failed`,
		 * a coalesced re-run, or a queue fed by something that wrote no row).
		 *
		 * `null` rather than a throw, because this runs BEFORE the review:
		 * `main.ts` calls `start()` outside its try block, so a rejected write
		 * would abort `runJob` before `runReview` was ever reached — no comment on
		 * the PR, the job marked `failed`, and the cause a bookkeeping table rather
		 * than the review. Measured with a failing store: `start()` rejected with
		 * the driver error and the review never ran.
		 *
		 * `null` rather than a fake id, because `finish()` would then UPDATE a row
		 * that does not exist. The caller tolerates a null id by skipping the
		 * update — the history is degraded, the review itself is unaffected.
		 */
		async start(input: RecordReviewStartInput): Promise<number | null> {
			const startedAt = now()
			try {
				const flipped = await deps.reviews.markRunning(input.owner, input.repo, input.pr, startedAt)
				if (flipped) return flipped.id

				const row = await deps.reviews.insertReview({
					owner: input.owner,
					repo: input.repo,
					pr: input.pr,
					kind: input.kind ?? "review",
					status: "running",
					startedAt,
				})
				return row.id
			} catch (err) {
				console.error(
					`[history] failed to start review row for ${input.owner}/${input.repo}#${input.pr}:`,
					err,
				)
				return null
			}
		},

		/**
		 * Move `id` to its terminal state.
		 *
		 * A failure to record history must never fail the review it describes:
		 * the comment is already on the PR, and turning a successful review into a
		 * thrown error because one INSERT failed would make the queue retry work
		 * that already happened. So this swallows and reports, exactly like the
		 * analytics writers.
		 */
		async finish(id: number | null, input: RecordReviewFinishInput): Promise<void> {
			// No id means `start()` could not insert, so there is no row to update.
			// Skipping the UPDATE is the whole point of returning null there.
			if (id === null) return
			try {
				await deps.reviews.updateReview(id, {
					status: input.status,
					model: input.model ?? null,
					// Recorded when the endpoint reports it, so the dashboard can
					// show the model that really answered rather than the one we
					// asked for. Null when the endpoint omits `model` (some
					// OpenAI-compatible servers do).
					servedModel: input.servedModel ?? null,
					markdown: input.markdown ?? null,
					score:
						input.score === undefined ? null : input.score === null ? null : String(input.score),
					error: input.error ?? null,
					headSha: input.headSha ?? null,
					finishedAt: now(),
				})
			} catch (err) {
				console.error(`[history] failed to record review ${id}:`, err)
			}
		},
	}
}

/** Exported for the composition root, which reads the score out of the YAML. */
export { scoreOf as extractReviewScore }

export type RecordReview = ReturnType<typeof makeRecordReview>

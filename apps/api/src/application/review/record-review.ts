// Record a finished review in the history table.
//
// WHY THIS EXISTS. `reviews` is the table the dashboard reads, and NOTHING WROTE
// TO IT. Measured on the live database: 88 rows in `review_queue_jobs` with
// state='done' and ZERO rows in `reviews` — so every review the system had ever
// run was invisible in the UI, and the list page's "No reviews yet." was
// accurate and permanent. The queue recorded that work happened; the history of
// what was said was never stored.
//
// Two rows are written per attempt, not one:
//
//   - a `queued` row at enqueue time, so a review that is still running (or that
//     hard-killed the process) is visible rather than absent;
//   - then that same row is moved to `success` or `failed`.
//
// That ordering is what makes `startedAt`/`finishedAt` meaningful on the detail
// page; writing only the terminal row would leave a finished review with no
// measurable duration, and a crashed one with no trace at all.

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
	/** The model that actually answered, after any fallback. */
	model?: string
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
		/** Insert the `queued` row and return its id. Never throws on a bad clock. */
		async start(input: RecordReviewStartInput): Promise<number> {
			const row = await deps.reviews.insertReview({
				owner: input.owner,
				repo: input.repo,
				pr: input.pr,
				kind: input.kind ?? "review",
				status: "queued",
				startedAt: now(),
			})
			return row.id
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
		async finish(id: number, input: RecordReviewFinishInput): Promise<void> {
			try {
				await deps.reviews.updateReview(id, {
					status: input.status,
					model: input.model ?? null,
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

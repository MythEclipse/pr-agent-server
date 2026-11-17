// The repository interface the application layer depends on.
//
// Kept in domain/ so the use-cases stay framework-free (skill §2.1) and
// unit-testable with plain fakes. The row types come from the schema rather
// than being redeclared here, so there is exactly one definition of what a
// review record is; the adapter in infrastructure/db/repositories/ returns
// these same shapes and never leaks a Drizzle type of its own.

import type { TNewReviewRow, TReviewRow } from "../../infrastructure/db/schema.ts"
import type { TReviewStatus } from "./review.ts"

export type { TNewReviewRow, TReviewRow }

export interface ReviewFilter {
	owner?: string
	repo?: string
	pr?: number
	status?: string
	kind?: string
	limit?: number
	offset?: number
}

export interface TReviewPage {
	rows: TReviewRow[]
	total: number
}

export interface ReviewRepository {
	insertReview(row: TNewReviewRow): Promise<TReviewRow>
	updateReview(id: number, patch: Partial<TNewReviewRow>): Promise<TReviewRow | null>
	getReview(id: number): Promise<TReviewRow | null>
	listReviews(filter: ReviewFilter): Promise<TReviewPage>
	/**
	 * Flip the newest `queued` row for this PR to `running`.
	 *
	 * Returns `null` when there is no queued row to flip — a job re-armed from
	 * `failed`, a coalesced re-run, or a run enqueued by a path that never wrote
	 * a row. The caller inserts a `running` row in that case rather than losing
	 * the history entry.
	 */
	markRunning(owner: string, repo: string, pr: number, startedAt: Date): Promise<TReviewRow | null>
	/**
	 * Fail every row that is still open from before `before`, returning how many
	 * were healed.
	 *
	 * A row with no `finished_at` is a claim about a live run, and the only thing
	 * that can keep it open forever is the process dying. Called once on boot,
	 * this is what stops `queued`/`running` from being permanent lies in the
	 * dashboard after a crash.
	 */
	markInterrupted(before: Date, message: string): Promise<number>
	/**
	 * How many rows carry each status.
	 *
	 * Every status is present in the result, including the ones with no rows:
	 * the dashboard renders a counter per status and a missing key would make it
	 * disappear rather than read zero.
	 */
	countByStatus(): Promise<Record<TReviewStatus, number>>
}

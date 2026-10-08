// The repository interface the application layer depends on.
//
// Kept in domain/ so the use-cases stay framework-free (skill §2.1) and
// unit-testable with plain fakes. The row types come from the schema rather
// than being redeclared here, so there is exactly one definition of what a
// review record is; the adapter in infrastructure/db/repositories/ returns
// these same shapes and never leaks a Drizzle type of its own.

import type { TNewReviewRow, TReviewRow } from "../../infrastructure/db/schema.ts"

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
}

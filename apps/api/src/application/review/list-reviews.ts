// List review history. A pure function of its repository dependency, so the
// router can call it with a fake and the pagination rules stay testable
// without a database.

import type {
	ReviewFilter,
	ReviewRepository,
	TReviewPage,
} from "../../domain/review/review-repository.ts"

export type ListReviewsInput = ReviewFilter

export interface ListReviewsDeps {
	reviews: ReviewRepository
}

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

export function makeListReviews(deps: ListReviewsDeps) {
	return async (input: ListReviewsInput = {}): Promise<TReviewPage> => {
		const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
		const offset = Math.max(input.offset ?? 0, 0)
		return deps.reviews.listReviews({ ...input, limit, offset })
	}
}

export type ListReviews = ReturnType<typeof makeListReviews>

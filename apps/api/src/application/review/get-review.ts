// Fetch one review by id. Throws NOT_FOUND rather than returning null, so the
// router's error mapping produces a 404 without a special case here.

import type { TReview } from "../../domain/review/review.ts"
import type { ReviewRepository } from "../../domain/review/review-repository.ts"
import { notFound } from "../shared/errors.ts"

export interface GetReviewInput {
	id: number
}

export interface GetReviewDeps {
	reviews: ReviewRepository
}

export function makeGetReview(deps: GetReviewDeps) {
	return async (input: GetReviewInput): Promise<TReview> => {
		if (!Number.isInteger(input.id) || input.id <= 0) {
			throw notFound(`no review with id ${input.id}`)
		}
		const found = await deps.reviews.getReview(input.id)
		if (!found) throw notFound(`no review with id ${input.id}`)
		return found
	}
}

export type GetReview = ReturnType<typeof makeGetReview>

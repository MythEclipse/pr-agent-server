// Counts per status, for the dashboard's live indicators.
//
// WHY THE DASHBOARD NEEDS THIS. The list endpoint can only answer one status at
// a time, so the header had no way to say "2 running, 3 queued" without one
// request per status — and it said nothing at all, which is how the two live
// statuses went unnoticed for as long as they did: `running` matched no row
// anywhere (nothing wrote it) and `queued` matched nine rows whose process had
// died days earlier.
//
// Counted from the same table the list reads, so the header and the rows cannot
// disagree.

import type { TReviewStatus } from "../../domain/review/review.ts"
import type { ReviewRepository } from "../../domain/review/review-repository.ts"

export interface CountReviewsDeps {
	reviews: ReviewRepository
}

export function makeCountReviews(deps: CountReviewsDeps) {
	return async (): Promise<Record<TReviewStatus, number>> => deps.reviews.countByStatus()
}

export type CountReviews = ReturnType<typeof makeCountReviews>

// The single source of truth for what the presentation layer may call
// (skill §2.2). Every dependency arrives from main.ts; nothing here imports
// db, redis or auth directly.

import type { TReview } from "../domain/review/review.ts"
import type { ReviewRepository } from "../domain/review/review-repository.ts"
import { makeGetReview } from "./review/get-review.ts"
import { makeListReviews } from "./review/list-reviews.ts"

export interface UseCaseDeps {
	reviews: ReviewRepository
	/**
	 * The legacy pipeline, passed as already-bound functions. They keep their
	 * original (cfg, owner, repo, pr, pem) signatures for now: the port exists
	 * so presentation never reaches past it, not to force a rewrite of bodies
	 * that are already covered by 48 passing tests.
	 */
	legacy: {
		runReview: (owner: string, repo: string, pr: number) => Promise<unknown>
		runDescribe: (owner: string, repo: string, pr: number) => Promise<unknown>
		runImprove: (owner: string, repo: string, pr: number) => Promise<unknown>
	}
}

export function buildUseCases(deps: UseCaseDeps) {
	return {
		review: {
			list: makeListReviews({ reviews: deps.reviews }),
			get: makeGetReview({ reviews: deps.reviews }),
		},
		legacy: deps.legacy,
	}
}

export type UseCases = ReturnType<typeof buildUseCases>

/** Re-exported so routers can type a single review without reaching into the repo. */
export type { TReview }

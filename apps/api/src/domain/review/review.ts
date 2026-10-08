// The review aggregate's value types, mirrored out of the repository row so
// the application layer never imports a schema type at its call sites.

import type { TReviewRow } from "./review-repository.ts"

export type TReview = TReviewRow
export type TReviewKind = "review" | "describe" | "improve"
export type TReviewStatus = "queued" | "running" | "success" | "failed"

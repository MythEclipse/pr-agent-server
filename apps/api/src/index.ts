// Type-only barrel (skill §1). The web app imports from here and MUST NOT
// import a runtime symbol — everything below is erased at compile time.

export type { TAppRole } from "./application/shared/authorization.ts"
export type { TQueueJob, TQueueStats } from "./domain/review/queue-repository.ts"
export type { TReview, TReviewKind, TReviewStatus } from "./domain/review/review.ts"
export type { TSession } from "./presentation/orpc/context.ts"
export type { AppRouter } from "./presentation/routers/index.ts"

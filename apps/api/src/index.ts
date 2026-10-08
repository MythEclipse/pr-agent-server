// Type-only barrel (skill §1). The web app imports from here and MUST NOT
// import a runtime symbol — everything below is erased at compile time.
//
// TClient is the client-facing view of the router: the shape the browser calls
// through. It is derived here so the web app never has to depend on @orpc/*
// itself, keeping @orpc/server a backend-only dependency.

import type { RouterClient } from "@orpc/server"
import type { AppRouter } from "./presentation/routers/index.ts"

export type { AppRouter }
export type TClient = RouterClient<AppRouter>

export type { TAppRole } from "./application/shared/authorization.ts"
export type { TQueueJob, TQueueStats } from "./domain/review/queue-repository.ts"
export type { TReview, TReviewKind, TReviewStatus } from "./domain/review/review.ts"
export type { TSession } from "./presentation/orpc/context.ts"

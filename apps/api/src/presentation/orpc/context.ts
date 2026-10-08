// The oRPC request context.
//
// Single-tenant, so there is no orgRole: the only authorization input is the
// session resolved by better-auth, whose `role` is the sole axis.

import type { TAppRole } from "../../application/shared/authorization.ts"
import { unauthorized } from "../../application/shared/errors.ts"
import type { UseCases } from "../../application/use-cases.ts"
import type { QueueRepository } from "../../domain/review/queue-repository.ts"
import type { ReviewRepository } from "../../domain/review/review-repository.ts"

export interface TSession {
	userId: string
	email: string
	name: string
	role: TAppRole
}

export interface ORPCContext {
	headers: Headers
	/** Null for an anonymous caller; every protected procedure checks this. */
	session: TSession | null
	useCases: UseCases
	reviews: ReviewRepository
	queueStore: QueueRepository
}

/** Build a context from the request headers plus whatever deps are wired. */
export async function buildContext(
	headers: Headers,
	deps: {
		useCases: UseCases
		reviews: ReviewRepository
		queueStore: QueueRepository
		resolveSession: (headers: Headers) => Promise<TSession | null>
	},
): Promise<ORPCContext> {
	let session: TSession | null = null
	try {
		session = await deps.resolveSession(headers)
	} catch {
		// An unreadable cookie is an anonymous request, not a 500 — the
		// protected procedures produce the right error from there.
		session = null
	}
	return {
		headers,
		session,
		useCases: deps.useCases,
		reviews: deps.reviews,
		queueStore: deps.queueStore,
	}
}

/** Narrow a context to one with a session, or throw UNAUTHORIZED. */
export function requireSession(ctx: ORPCContext): TSession {
	if (!ctx.session) throw unauthorized("authentication required")
	return ctx.session
}

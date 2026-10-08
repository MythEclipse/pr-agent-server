// Procedure builders (skill §2.5).
//
//   publicProcedure    no session required
//   protectedProcedure a session is required
//   adminProcedure     session + the `admin` role — the single-tenant axis
//
// The AppError -> ORPCError mapping is applied at the BASE, so every procedure
// inherits it and a procedure added later cannot forget. Without this an
// UNAUTHORIZED thrown by requireSession surfaces as a generic 500 and a plain
// user learns nothing from what should be a 401.

import { os } from "@orpc/server"
import { assertRole, type TAppRole } from "../../application/shared/authorization.ts"
import type { ORPCContext } from "./context.ts"
import { requireSession } from "./context.ts"
import { toOrpcError } from "./error-mapping.ts"

/** The shared base every procedure below is built from. */
const base = os.$context<ORPCContext>().use(async ({ next }) => {
	try {
		return await next()
	} catch (err) {
		throw toOrpcError(err)
	}
})

export const publicProcedure = base

export const protectedProcedure = base.use(({ context, next }) => {
	const session = requireSession(context)
	return next({ context: { ...context, session } })
})

export function requireRole(...roles: TAppRole[]) {
	return base.use(({ context, next }) => {
		const session = requireSession(context)
		assertRole(session.role, roles)
		return next({ context: { ...context, session } })
	})
}

export const adminProcedure = requireRole("admin")

export { toOrpcError }

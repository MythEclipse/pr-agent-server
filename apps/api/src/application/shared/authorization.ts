// Single-tenant authorization (skill §0's stripping rules applied).
//
// There is no organization/member/role aggregate and no orgRole: the only
// role axis is the platform `user.role`, whose values are `admin | user`.
// requireRole("admin") in presentation/orpc/middleware.ts is the authoritative
// check; a beforeLoad guard in the SPA is only the UX half.

import { forbidden } from "./errors.ts"

export type TAppRole = "admin" | "user"

/** True when the session's role is one of `allowed`. */
export function hasRole(sessionRole: string | undefined, allowed: readonly TAppRole[]): boolean {
	return typeof sessionRole === "string" && (allowed as readonly string[]).includes(sessionRole)
}

/**
 * Authoritative role check. Throws FORBIDDEN rather than returning a boolean,
 * so a caller cannot forget to branch on the result.
 */
export function assertRole(sessionRole: string | undefined, allowed: readonly TAppRole[]): void {
	if (!hasRole(sessionRole, allowed)) {
		throw forbidden(`requires role ${allowed.join(" or ")}`)
	}
}

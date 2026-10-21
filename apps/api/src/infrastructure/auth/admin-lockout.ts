// A boot-time guard for the failure mode that locked the operator out of their own
// dashboard: an admin account exists, can sign in, and is then refused on EVERY
// request because its address is not on AUTH_ALLOWED_EMAILS.
//
// That is the worst shape a permissions bug can take. Sign-in returns 200 and sets
// a cookie, so the browser looks signed in; the dashboard then renders empty
// because every RPC answers 401. Nothing in the process said "the allowlist does
// not include any admin" — the rejection log line named the user, not the mistake,
// and it repeated per request instead of appearing once at boot.
//
// The allowlist stays the authority (it runs on every request and cannot be
// bypassed just because a row exists). This only makes a misconfiguration LOUD at
// startup, where the operator is looking, instead of silently degrading the UI.

import { eq } from "drizzle-orm"
import { user } from "../db/auth-schema.ts"
import type { IDbHandle } from "../db/client.ts"
import { isEmailAllowed } from "./allowlist.ts"

/** The minimum an account needs for the check: its address. */
export interface TAccountEmail {
	email: string
}

/** Addresses of every account whose role is `admin`. */
export async function listAdminEmails(db: IDbHandle["db"]): Promise<TAccountEmail[]> {
	const rows = await db.select({ email: user.email }).from(user).where(eq(user.role, "admin"))
	return rows.map((row) => ({ email: row.email }))
}

/**
 * One warning line per admin the allowlist will refuse. Empty when at least one
 * admin can actually use the dashboard, or when there are no admins yet (a fresh
 * install before `seed` — a different problem, reported by seed itself).
 */
export function describeAdminLockout(
	admins: readonly TAccountEmail[],
	allowed: readonly string[],
): string[] {
	return admins
		.filter((admin) => !isEmailAllowed(admin.email, allowed))
		.map(
			(admin) =>
				`[auth] admin account ${admin.email} is NOT on AUTH_ALLOWED_EMAILS — ` +
				"it can sign in but every request will be refused (401). " +
				"Add it to AUTH_ALLOWED_EMAILS, or this dashboard has no usable admin.",
		)
}

// The email allowlist — the ONLY thing standing between "Sign in with Google"
// and a public dashboard.
//
// WHY THIS IS NOT just a Google `hd` restriction: `hd` limits sign-in to a Google
// Workspace domain, which this deployment does not have. The operator's account
// is a plain gmail.com address, so the boundary has to be an explicit list of
// addresses.
//
// WHY IT IS ENFORCED IN TWO PLACES. Google authenticates anybody; the allowlist
// decides who may exist here. Both entry points matter:
//
//   1. `databaseHooks.user.create.before` — rejects a sign-in that would CREATE
//      an account. This is the one that matters for a new attacker: no row, no
//      session, no access.
//   2. the session check in the API — a row could already exist from an earlier
//      deploy (the seeded admin), or the allowlist could be tightened later. An
//      existing account must lose access when its address leaves the list,
//      otherwise "remove them from the allowlist" would not actually remove them.
//
// Failing closed is deliberate: an empty or unparseable allowlist denies
// everybody. The alternative reading — "no allowlist configured means allow all"
// — turns a forgotten env var into an open door to the review history.

/** Normalise one address: trim and lowercase. Emails are case-insensitive. */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase()

/**
 * Parse the comma-separated `AUTH_ALLOWED_EMAILS` value.
 *
 * Order-preserving and de-duplicated. Empty entries (a trailing comma, the empty
 * default) are dropped rather than treated as "allow the empty string".
 */
export function parseAllowlist(raw: string): string[] {
	return [
		...new Set(
			raw
				.split(",")
				.map(normaliseEmail)
				.filter((e) => e.length > 0),
		),
	]
}

/** Is `email` on the list? Empty list allows nobody. */
export function isEmailAllowed(
	email: string | null | undefined,
	allowlist: readonly string[],
): boolean {
	if (!email) return false
	const target = normaliseEmail(email)
	return allowlist.some((allowed) => allowed === target)
}

/**
 * The message a rejected sign-in sees.
 *
 * Deliberately says only that this account is not authorised. It must NOT reveal
 * whether the address exists, and must not name who IS allowed — a sign-in page
 * that leaks the operator's address is a phishing target list.
 */
export const NOT_ALLOWED_MESSAGE = "This account is not authorised to use this dashboard."

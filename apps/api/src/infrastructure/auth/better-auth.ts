// better-auth instance, single-tenant.
//
// No organizationClient: the deployment serves one org, so the org plugin
// would only create tables the app never reads. `role` is the sole
// authorization axis.
//
// SIGN-IN SURFACES: email+password (the seeded admin) and Google OAuth. Google is
// gated by an explicit email allowlist, because Google will authenticate any
// account on the planet and this dashboard exposes every reviewed repo, PR and
// model response.

import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError } from "better-auth/api"
import * as authSchema from "../db/auth-schema.ts"
import type { TDb } from "../db/client.ts"
import { isEmailAllowed, NOT_ALLOWED_MESSAGE } from "./allowlist.ts"

export interface BuildAuthOptions {
	db: TDb
	secret: string
	baseURL: string
	/** Comma-separated list; single-origin in production behind one host. */
	trustedOrigins: string[]
	/**
	 * The ONLY addresses allowed to hold an account. Already parsed and normalised
	 * (see `parseAllowlist`). Empty means nobody may sign in.
	 */
	allowedEmails?: readonly string[]
	/** Omit both and the Google provider is not registered at all. */
	google?: {
		clientId: string
		clientSecret: string
	}
}

export function buildAuth(opts: BuildAuthOptions) {
	const allowlist = opts.allowedEmails ?? []

	return betterAuth({
		secret: opts.secret,
		baseURL: opts.baseURL,
		trustedOrigins: opts.trustedOrigins,
		database: drizzleAdapter(opts.db as never, {
			provider: "pg",
			schema: {
				user: authSchema.user,
				session: authSchema.session,
				account: authSchema.account,
				verification: authSchema.verification,
			},
		}),
		/**
		 * The allowlist, enforced where an account is CREATED.
		 *
		 * A Google sign-in from an address that is not on the list must not get as
		 * far as a user row: no row means no session, no dashboard, and nothing to
		 * clean up afterwards. Throwing `APIError` (not returning false) is what
		 * produces a real 403 the login page can display, instead of a silent no-op
		 * that leaves the browser on a blank redirect.
		 *
		 * This covers BOTH surfaces on purpose. Email+password registration is not
		 * exposed by the UI, but the endpoint exists, and an allowlist that only
		 * guarded OAuth would leave that door open.
		 */
		databaseHooks: {
			user: {
				create: {
					// Async because the hook signature requires a Promise; the check itself is
					// synchronous and needs no I/O.
					before: async (user) => {
						if (!isEmailAllowed(user.email, allowlist)) {
							// Logged, because from the outside this is indistinguishable from a
							// wrong password and the operator needs to know it happened.
							console.warn(
								`[auth] rejected sign-in for ${user.email}: not on AUTH_ALLOWED_EMAILS (${allowlist.length} entries)`,
							)
							throw new APIError("FORBIDDEN", { message: NOT_ALLOWED_MESSAGE })
						}
						// EVERY account that can be created here is admin, because the
						// allowlist IS the operator list — and the dashboard is admin-only
						// (`review.list`, `review.get`, `queue.stats` all use adminProcedure).
						//
						// Without this the flow is broken in the same shape as the allowlist
						// lockout: Google sign-in succeeds, a row is created with the schema
						// default `role=user`, and then every page answers 403. The user is
						// signed in and sees an empty dashboard, and nothing says why.
						//
						// The promotion is only on CREATE, so a later demotion (UPDATE the
						// role) sticks — adding a read-only viewer later does not mean
						// fighting this hook on every sign-in.
						//
						// `input: false` on the field still holds: this is server-side, and a
						// registration body cannot ask for a role.
						return { data: { ...user, role: "admin" } }
					},
				},
			},
		},
		user: {
			additionalFields: {
				// Read by the single-tenant authorization axis. Defaults to
				// "user", and input:false keeps a registration form from
				// choosing its own role — only the seed script grants admin.
				role: { type: "string", defaultValue: "user", input: false },
			},
		},
		emailAndPassword: {
			enabled: true,
		},
		// Registered only when both halves exist. A provider with an empty client
		// secret would fail at the token exchange with a confusing 401 from Google.
		...(opts.google
			? {
					socialProviders: {
						google: {
							clientId: opts.google.clientId,
							clientSecret: opts.google.clientSecret,
							// Ask for the verified address: the allowlist matches on email, so an
							// unverified address would let someone claim a listed account.
							scope: ["openid", "email", "profile"],
						},
					},
				}
			: {}),
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
		},
	})
}

export type TAuth = ReturnType<typeof buildAuth>

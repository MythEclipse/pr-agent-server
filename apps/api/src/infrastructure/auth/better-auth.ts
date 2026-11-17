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
	/** Trusted local provisioning only. Never enable on the HTTP server. */
	allowPasswordSignUp?: boolean
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
		// Public password registration is disabled. Google-created accounts must
		// carry a verified address before the allowlist can grant operator access.
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
						if (!opts.allowPasswordSignUp && user.emailVerified !== true) {
							throw new APIError("FORBIDDEN", { message: NOT_ALLOWED_MESSAGE })
						}
						return { data: { ...user, role: "admin" } }
					},
				},
			},
		},
		user: {
			additionalFields: {
				// Read by the single-tenant authorization axis. Defaults to
				// "user", and input:false keeps a registration form from
				// choosing its own role. The hook grants it after identity checks.
				role: { type: "string", defaultValue: "user", input: false },
			},
		},
		emailAndPassword: {
			enabled: true,
			disableSignUp: !opts.allowPasswordSignUp,
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

// better-auth instance, single-tenant.
//
// No organizationClient: the deployment serves one org, so the org plugin
// would only create tables the app never reads. `role` is the sole
// authorization axis.

import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import * as authSchema from "../db/auth-schema.ts"
import type { TDb } from "../db/client.ts"

export interface BuildAuthOptions {
	db: TDb
	secret: string
	baseURL: string
	/** Comma-separated list; single-origin in production behind one host. */
	trustedOrigins: string[]
}

export function buildAuth(opts: BuildAuthOptions) {
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
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
		},
	})
}

export type TAuth = ReturnType<typeof buildAuth>

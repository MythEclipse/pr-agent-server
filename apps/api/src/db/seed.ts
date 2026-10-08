// One-shot admin seed.
//
// The dashboard is behind better-auth and the role field is `input: false`, so
// there is no signup path that could grant admin — this script is the only way
// the first admin exists. Idempotent: re-running with the same email is a no-op.
//
// Credentials come from the environment, never from a checked-in file:
//   SEED_ADMIN_EMAIL     required
//   SEED_ADMIN_PASSWORD  required, min 12 chars
//   SEED_ADMIN_NAME      optional, defaults to "Admin"

import { eq } from "drizzle-orm"
import { buildAuth } from "../infrastructure/auth/better-auth.ts"
import { loadEnv } from "../infrastructure/config/env.ts"
import { user } from "../infrastructure/db/auth-schema.ts"
import { createDb } from "../infrastructure/db/client.ts"

async function main(): Promise<void> {
	const env = loadEnv()
	const email = process.env.SEED_ADMIN_EMAIL
	const password = process.env.SEED_ADMIN_PASSWORD

	if (!email || !password) {
		console.error("pr-agent-api seed: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD")
		process.exit(2)
	}
	if (password.length < 12) {
		console.error("pr-agent-api seed: SEED_ADMIN_PASSWORD must be at least 12 characters")
		process.exit(2)
	}

	const { db, close } = createDb(env.DATABASE_URL)
	try {
		const existing = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, email))
			.limit(1)
		if (existing[0]) {
			console.log(`pr-agent-api seed: ${email} already exists — nothing to do`)
			return
		}

		// better-auth hashes the password itself; writing the row directly would
		// store a plaintext credential.
		const auth = buildAuth({
			db,
			secret: env.BETTER_AUTH_SECRET,
			baseURL: env.BETTER_AUTH_URL,
			trustedOrigins: [env.WEB_ORIGIN],
		})
		await auth.api.signUpEmail({
			body: { email, password, name: process.env.SEED_ADMIN_NAME ?? "Admin" },
		})

		// The signup above creates role="user" by default. Promote explicitly —
		// this is the only place the admin role is ever granted.
		await db.update(user).set({ role: "admin" }).where(eq(user.email, email))

		console.log(`pr-agent-api seed: admin created for ${email}`)
	} finally {
		await close()
	}
}

await main()

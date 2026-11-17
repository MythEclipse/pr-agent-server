// One-shot admin seed.
//
// The dashboard is behind better-auth and the role field is `input: false`, so
// public password signup is disabled. This script provisions the password admin.
// Re-running with the same email is a no-op.
//
// Credentials come from the environment, never from a checked-in file:
//   SEED_ADMIN_EMAIL     required
//   SEED_ADMIN_PASSWORD  required, min 12 chars
//   SEED_ADMIN_NAME      optional, defaults to "Admin"

import { seedAdmin } from "../infrastructure/auth/seed-admin.ts"
import { loadEnv } from "../infrastructure/config/env.ts"
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
		const result = await seedAdmin({
			db,
			secret: env.BETTER_AUTH_SECRET,
			baseURL: env.BETTER_AUTH_URL,
			trustedOrigins: [env.WEB_ORIGIN],
			email,
			password,
			name: process.env.SEED_ADMIN_NAME ?? "Admin",
		})
		console.log(
			`pr-agent-api seed: ${email} ${result === "created" ? "admin created" : "already exists — nothing to do"}`,
		)
	} finally {
		await close()
	}
}

await main()

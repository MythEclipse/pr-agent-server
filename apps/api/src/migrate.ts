// Standalone migration entrypoint (skill §5). Runs as its own deploy step so
// migrations stay decoupled from application boot: a schema change and a code
// rollback are then independent operations.

import { resolve } from "node:path"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { z } from "zod"
import { createDb } from "./infrastructure/db/client.ts"

// Deliberately not loadEnv(). This script applies SQL and touches nothing else,
// so the only variable it can fail on is the one it actually uses — requiring
// BETTER_AUTH_SECRET here meant the deploy step could not run until every
// application secret happened to be exported too, for no benefit. The full
// environment is still validated exactly once, by the app that needs it.
const envSchema = z.object({
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
})

async function main(): Promise<void> {
	const parsed = envSchema.safeParse(process.env)
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("\n")
		throw new Error(`Invalid environment:\n${issues}`)
	}

	const { db, close } = createDb(parsed.data.DATABASE_URL)
	try {
		// Relative to this file, not the cwd: systemd runs the unit from
		// WorkingDirectory=/opt/pr-agent-server while dist/migrate.js sits in
		// dist/, so "./drizzle" would resolve to a directory that is not there.
		await migrate(db, { migrationsFolder: resolve(import.meta.dirname, "./drizzle") })
		console.log("pr-agent-api: migrations applied")
	} finally {
		await close()
	}
}

await main()

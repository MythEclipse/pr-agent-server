// Standalone migration entrypoint (skill §5). Runs as its own deploy step so
// migrations stay decoupled from application boot: a schema change and a code
// rollback are then independent operations.

import { migrate } from "drizzle-orm/node-postgres/migrator"
import { loadEnv } from "./infrastructure/config/env.ts"
import { createDb } from "./infrastructure/db/client.ts"

async function main(): Promise<void> {
	const env = loadEnv()
	const { db, close } = createDb(env.DATABASE_URL)
	try {
		await migrate(db, { migrationsFolder: "./drizzle" })
		console.log("pr-agent-api: migrations applied")
	} finally {
		await close()
	}
}

await main()

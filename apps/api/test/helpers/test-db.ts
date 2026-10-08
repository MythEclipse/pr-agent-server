// In-process Postgres for tests.
//
// The suite needs a real Postgres engine — the queue's correctness rests on
// ON CONFLICT, SELECT ... FOR UPDATE SKIP LOCKED and unique indexes, and a
// sqlite stand-in would exercise none of that. PGlite is Postgres compiled to
// WASM, so the same SQL runs here as in production with no external server.
//
// Test-only: the app never imports this file.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as schema from "../../src/infrastructure/db/schema.ts"

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle")

export interface ITestDb {
	db: ReturnType<typeof drizzle<typeof schema>>
	close(): Promise<void>
}

/** Apply every committed migration under drizzle/ to a fresh in-memory DB. */
export async function createTestDb(): Promise<ITestDb> {
	const client = new PGlite()
	const journal = JSON.parse(
		readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
	) as { entries: { tag: string }[] }

	for (const entry of journal.entries) {
		const sql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8")
		await client.exec(sql)
	}

	return {
		db: drizzle(client, { schema }),
		close: async () => {
			await client.close()
		},
	}
}

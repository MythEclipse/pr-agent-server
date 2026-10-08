// Drizzle client factory. One place that knows a pg Pool exists; nothing else
// in the app imports `pg` directly.

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "./schema.ts"

export type TDb = NodePgDatabase<typeof schema>

export interface IDbHandle {
	db: TDb
	pool: Pool
	close(): Promise<void>
}

export function createDb(databaseUrl: string): IDbHandle {
	const pool = new Pool({ connectionString: databaseUrl })
	return {
		db: drizzle(pool, { schema }),
		pool,
		close: async () => {
			await pool.end()
		},
	}
}

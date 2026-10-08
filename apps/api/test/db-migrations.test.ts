// The committed migrations are the only schema a deploy ever applies.
//
// This exists because of a real bug: drizzle.config.ts pointed at schema.ts
// alone, so the better-auth tables — which live in auth-schema.ts — were never
// part of the migration input. The app booted, every review/queue test passed,
// and the first `db:seed` on a fresh database died with:
//
//     relation "user" does not exist
//
// Nothing else in the suite noticed, because every other test used a database
// it built from schema definitions directly rather than from these SQL files.
// So: apply the migrations for real, then assert the tables the app actually
// queries are present. A future config change that drops a schema module from
// the input fails here rather than in production.

import { describe, expect, test } from "vitest"
import { createTestDb } from "./helpers/test-db.ts"

describe("committed migrations", () => {
	test("create every table the app queries", async () => {
		const store = await createTestDb()
		try {
			const tables = await store.db.execute(
				"select table_name from information_schema.tables where table_schema = 'public'",
			)
			const present = rowsOf(tables) as { table_name: string }[]

			// The app's own two.
			expect(present.map((r) => r.table_name)).toEqual(
				expect.arrayContaining(["reviews", "review_queue_jobs"]),
			)
			// better-auth's four. Omitting any of these means nobody can sign in.
			expect(present.map((r) => r.table_name)).toEqual(
				expect.arrayContaining(["user", "session", "account", "verification"]),
			)
		} finally {
			await store.close()
		}
	})

	test("user carries the role column the single-tenant gate reads", async () => {
		const store = await createTestDb()
		try {
			const columns = await store.db.execute(
				"select column_name from information_schema.columns where table_name = 'user'",
			)
			const names = (rowsOf(columns) as { column_name: string }[]).map((r) => r.column_name)
			// snake_case on disk, camelCase in Drizzle: the mismatch here is how a
			// silently-renamed column would reach a deploy.
			expect(names).toEqual(expect.arrayContaining(["email", "role", "email_verified"]))
			expect(names).not.toContain("emailVerified")
		} finally {
			await store.close()
		}
	})
})

/** PGlite returns rows directly; drizzle-orm/pglite returns { rows }. */
function rowsOf(result: unknown): unknown[] {
	const rows = (result as { rows?: unknown[] }).rows
	return Array.isArray(rows) ? rows : (result as unknown[])
}

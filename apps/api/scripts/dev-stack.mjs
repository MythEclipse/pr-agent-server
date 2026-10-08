// Local dev stack: PGlite exposed on a TCP port so the app can talk to it with
// the ordinary node-postgres driver.
//
// The compose file in docker-compose.dev.yml is the intended dev database, but
// this host has no Docker, and an unrelated Postgres already owns 5432 with
// credentials we do not have. This harness gets the real thing running anyway:
// PGlite is Postgres compiled to WASM, so the same SQL executes against it,
// and @electric-sql/pglite-socket puts the PostgreSQL wire protocol in front of
// it so nothing in the app knows the difference.
//
// Dev-only. Nothing in src/ imports this; it exists so WEB_DIST_PATH and the
// oRPC/OpenAPI surface can be exercised end to end on a machine without Docker.
//
//   node scripts/dev-stack.mjs [--port 5433]

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"

const portFlag = process.argv.indexOf("--port")
const port = portFlag === -1 ? 5433 : Number(process.argv[portFlag + 1])

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

const db = new PGlite()
const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"))
for (const entry of journal.entries) {
	await db.exec(readFileSync(join(migrationsDir, `${entry.tag}.sql`), "utf8"))
}
console.log(`applied ${journal.entries.length} migration(s)`)

const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 10 })
await server.start()
console.log(`pglite listening on 127.0.0.1:${port} — ctrl-c to stop`)

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		void (async () => {
			await server.stop()
			await db.close()
			process.exit(0)
		})()
	})
}

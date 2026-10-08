// Entry point: `node dist/main.js` starts the server.
//
// `import.meta.main` was the Bun guard; Node's equivalent is comparing
// process.argv[1] against this module's path, which answers the same
// "am I the process being run?" question with no framework dependency.

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { startServer } from "./presentation/http/legacy-server.ts"

function isEntrypoint(): boolean {
	const entry = process.argv[1]
	if (!entry) return false
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
	} catch {
		return false
	}
}

if (isEntrypoint()) {
	startServer()
}

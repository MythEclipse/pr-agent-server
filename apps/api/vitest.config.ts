import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "src/**/*.test.ts"],
		environment: "node",
		// Same reason the worker config sets this: the suite is limited by real work,
		// not by assertions. Every DB-backed test boots a PGlite instance (Postgres
		// compiled to WASM) and applies all committed migrations before it can assert
		// anything — measured at ~2s per test on an idle box. `moon run :test` runs
		// the worker suite CONCURRENTLY, so on a loaded machine a first-time PGlite
		// boot exceeded vitest's 5s default and the test failed on TIMEOUT rather than
		// on its assertion (observed: 13.5s per test, four tests red with the same
		// tests passing in isolation).
		//
		// Raising the ceiling does not mask a hang: a real deadlock still fails, just
		// later. It stops a slow CI box from reporting a timeout as a logic failure.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
})

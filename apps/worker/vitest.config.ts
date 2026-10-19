import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "src/**/*.test.ts"],
		environment: "node",
		// Runs BEFORE the first test module is imported, which is the only point
		// early enough to stop a live webhook URL from reaching a module-level
		// `process.env` read. See the file's header for the 2026-10-19 incident
		// it prevents: this suite posted 120 `t`/`l` embeds to the real channel.
		setupFiles: ["./test/setup-hermetic.ts"],
		// The worker spawns real git/gh child processes and binds loopback
		// sockets; give those suites room without hiding a real hang.
		testTimeout: 30_000,
	},
})

import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts", "src/**/*.test.ts"],
		environment: "node",
		// The worker spawns real git/gh child processes and binds loopback
		// sockets; give those suites room without hiding a real hang.
		testTimeout: 30_000,
	},
})

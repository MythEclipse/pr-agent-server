import { defineConfig } from "drizzle-kit"

// Migrations are generated here and committed (skill §5). The runtime never
// migrates on boot: deploy runs `node dist/migrate.js` as its own step.
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/infrastructure/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://pr_agent:pr_agent_dev@127.0.0.1:5432/pr_agent_dev",
	},
	strict: true,
	verbose: true,
})

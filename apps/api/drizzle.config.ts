import { defineConfig } from "drizzle-kit"

// Migrations are generated here and committed (skill §5). The runtime never
// migrates on boot: deploy runs `node dist/migrate.js` as its own step.
export default defineConfig({
	dialect: "postgresql",
	// BOTH modules, not just schema.ts. The better-auth tables (user, session,
	// account, verification) live in auth-schema.ts because better-auth validates
	// their exact column names at boot — but pointing drizzle-kit at schema.ts
	// alone meant they were never part of the migration input, so a fresh
	// `db:migrate` produced a database with no way to sign in.
	schema: ["./src/infrastructure/db/schema.ts", "./src/infrastructure/db/auth-schema.ts"],
	out: "./drizzle",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://pr_agent:pr_agent_dev@127.0.0.1:5432/pr_agent_dev",
	},
	strict: true,
	verbose: true,
})

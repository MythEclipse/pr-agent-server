// Zod-validated environment (skill §2.4). Throws once at startup with every
// issue listed at once, rather than failing later on the first unset var.
//
// DATABASE_URL has no default: a missing database is a deployment mistake the
// operator must see immediately, not a silent fallback to an in-memory store.

import { z } from "zod"

const envSchema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

	DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

	/** `memory` keeps the pre-P3 in-process queue; `db` makes it restart-safe. */
	QUEUE_BACKEND: z.enum(["memory", "db"]).default("memory"),

	/** better-auth (P4). */
	BETTER_AUTH_SECRET: z.string().min(16, "use `openssl rand -hex 32`"),
	BETTER_AUTH_URL: z.string().url().default("http://localhost:4023"),
	WEB_ORIGIN: z.string().url().default("http://localhost:5173"),

	/** Where the API serves the built SPA. Unset in dev — Vite serves it. */
	WEB_DIST_PATH: z.string().optional(),

	PORT: z.coerce.number().int().positive().default(4023),
})

export type TEnv = z.infer<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): TEnv {
	const parsed = envSchema.safeParse(source)
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("\n")
		throw new Error(`Invalid environment:\n${issues}`)
	}
	return parsed.data
}

/**
 * Test-friendly loader: DATABASE_URL and BETTER_AUTH_SECRET are supplied by the
 * suite (or defaulted here) so importing config never makes tests depend on
 * process.env being set a particular way.
 */
export function loadEnvWithDefaults(overrides: Partial<TEnv> = {}): TEnv {
	return {
		NODE_ENV: "test",
		DATABASE_URL: "postgres://pr_agent:pr_agent_dev@127.0.0.1:5432/pr_agent_dev",
		QUEUE_BACKEND: "memory",
		BETTER_AUTH_SECRET: "test-secret-not-used-in-production-0123456789",
		BETTER_AUTH_URL: "http://localhost:4023",
		WEB_ORIGIN: "http://localhost:5173",
		PORT: 4023,
		...overrides,
	}
}

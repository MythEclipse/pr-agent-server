import { eq } from "drizzle-orm"
import { user } from "../db/auth-schema.ts"
import { normaliseEmail } from "./allowlist.ts"
import { type BuildAuthOptions, buildAuth } from "./better-auth.ts"

export interface SeedAdminOptions
	extends Pick<BuildAuthOptions, "db" | "secret" | "baseURL" | "trustedOrigins"> {
	email: string
	password: string
	name: string
}

/** Local provisioning uses its own auth instance; HTTP signup stays disabled. */
export async function seedAdmin(opts: SeedAdminOptions): Promise<"created" | "exists"> {
	const email = normaliseEmail(opts.email)
	if (!email || opts.password.length < 12)
		throw new Error("Admin email and a password of at least 12 characters are required")
	const existing = await opts.db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1)
	if (existing[0]) return "exists"
	const auth = buildAuth({
		db: opts.db,
		secret: opts.secret,
		baseURL: opts.baseURL,
		trustedOrigins: opts.trustedOrigins,
		allowedEmails: [email],
		allowPasswordSignUp: true,
	})
	await auth.api.signUpEmail({ body: { email, password: opts.password, name: opts.name } })
	return "created"
}

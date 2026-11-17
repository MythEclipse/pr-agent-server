import { describe, expect, test } from "vitest"
import { buildAuth } from "../src/infrastructure/auth/better-auth.ts"
import { seedAdmin } from "../src/infrastructure/auth/seed-admin.ts"
import { createTestDb } from "./helpers/test-db.ts"

const BASE = "http://localhost:4023"
const EMAIL = "operator@example.com"
const PASSWORD = "local-seed-password-1234"
const options = {
	secret: "provisioning-test-secret-not-production-0123456789",
	baseURL: BASE,
	trustedOrigins: [BASE],
}

describe("password provisioning boundary", () => {
	test("public signup cannot claim an allowlisted email or enable provisioning in its body", async () => {
		const store = await createTestDb()
		try {
			const auth = buildAuth({ ...options, db: store.db as never, allowedEmails: [EMAIL] })
			const response = await auth.handler(
				new Request(`${BASE}/api/auth/sign-up/email`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: BASE },
					body: JSON.stringify({
						email: EMAIL,
						name: "Claimed operator",
						password: PASSWORD,
						role: "admin",
						emailVerified: true,
						allowPasswordSignUp: true,
					}),
				}),
			)
			expect(response.status).toBe(400)
			expect(response.headers.get("set-cookie")).toBeNull()
			const rows = await store.db.execute('select id from "user"')
			expect(rows.rows).toEqual([])
		} finally {
			await store.close()
		}
	})

	test("local seed creates an admin idempotently; the normal server can sign it in", async () => {
		const store = await createTestDb()
		try {
			const seedOptions = {
				...options,
				db: store.db as never,
				email: ` ${EMAIL.toUpperCase()} `,
				password: PASSWORD,
				name: "Admin",
			}
			expect(await seedAdmin(seedOptions)).toBe("created")
			expect(await seedAdmin({ ...seedOptions, password: "different-password-1234" })).toBe(
				"exists",
			)
			const auth = buildAuth({ ...options, db: store.db as never, allowedEmails: [EMAIL] })
			const result = await auth.api.signInEmail({ body: { email: EMAIL, password: PASSWORD } })
			expect(result.user.role).toBe("admin")
			expect(result.token).toBeTruthy()
			const rows = await store.db.execute<{ email: string; role: string }>(
				'select email, role from "user"',
			)
			expect(rows.rows).toEqual([{ email: EMAIL, role: "admin" }])
		} finally {
			await store.close()
		}
	})

	test("the account creation hook requires a verified Google identity", async () => {
		const store = await createTestDb()
		try {
			const auth = buildAuth({ ...options, db: store.db as never, allowedEmails: [EMAIL] })
			const context = await auth.$context
			await expect(
				context.internalAdapter.createUser(
					{
						email: EMAIL,
						name: "Unverified",
						emailVerified: false,
					},
					{ method: "oauth", oauth: { providerId: "google", profile: {} } },
				),
			).rejects.toThrow()
			const created = await context.internalAdapter.createUser(
				{
					email: EMAIL,
					name: "Verified",
					emailVerified: true,
				},
				{ method: "oauth", oauth: { providerId: "google", profile: {} } },
			)
			expect(created.emailVerified).toBe(true)
			const rows = await store.db.execute<{ role: string }>('select role from "user"')
			expect(rows.rows).toEqual([{ role: "admin" }])
		} finally {
			await store.close()
		}
	})
})

// The allowlist has to be enforced by the REAL better-auth instance, not just by
// a helper that returns booleans. `auth-allowlist.test.ts` pins the pure logic;
// this file drives `buildAuth` against a real Postgres (PGlite) so the wiring —
// the `databaseHooks.user.create.before` registration and the `socialProviders`
// block — is exercised rather than assumed.
//
// Both halves matter:
//   1. a non-allowlisted address must not get a user row;
//   2. an ALLOWLISTED one must still be able to sign up (otherwise "locked down"
//      just means "locked out", and the fix would silently break login).

import { describe, expect, test } from "vitest"
import { isEmailAllowed, parseAllowlist } from "../src/infrastructure/auth/allowlist.ts"
import { buildAuth } from "../src/infrastructure/auth/better-auth.ts"
import { createTestDb, type ITestDb } from "./helpers/test-db.ts"

const SECRET = "test-secret-not-used-in-production-0123456789"
const BASE = "http://localhost:4023"

const makeAuth = (db: ITestDb["db"], allowedEmails: string[]) =>
	// PGlite and node-postgres are genuinely different drizzle drivers: the
	// transaction signatures differ at the type level though the SQL is identical
	// (that equivalence is the whole premise of the PGlite test helper). Narrow at
	// this one boundary rather than widening `buildAuth`'s parameter to `unknown` —
	// the production path should keep its real type.
	buildAuth({
		db: db as never,
		secret: SECRET,
		baseURL: BASE,
		trustedOrigins: [BASE],
		allowedEmails,
	})

/**
 * The auth tables live in `auth-schema.ts`, not in the review `schema.ts` the
 * test-db helper is typed against — so `db.query.user` does not exist here.
 * Read them with raw SQL: the row count IS the assertion (a rejected sign-in
 * must leave nothing behind), so it has to be a real read, not a mock.
 */
const userEmails = async (store: ITestDb): Promise<string[]> => {
	const res = await store.db.execute<{ email: string }>('select email from "user" order by email')
	return res.rows.map((r) => r.email)
}

const userRoles = async (store: ITestDb): Promise<{ email: string; role: string }[]> => {
	const res = await store.db.execute<{ email: string; role: string }>(
		'select email, role from "user" order by email',
	)
	return res.rows.map((r) => ({ email: r.email, role: r.role }))
}

describe("allowlist enforcement in better-auth", () => {
	test("rejects sign-up for an address that is not on the list", async () => {
		const store = await createTestDb()
		try {
			const auth = makeAuth(store.db, parseAllowlist("superaseph@gmail.com"))

			// The password path is the reachable one in a unit test; OAuth would need
			// a full Google redirect. Both funnel through the SAME create hook, which
			// is the thing under test.
			await expect(
				auth.api.signUpEmail({
					body: { email: "intruder@example.com", password: "a-long-enough-password", name: "X" },
				}),
			).rejects.toThrow()

			// The decisive assertion: no row was created, so there is no session to
			// hold and nothing left behind to clean up.
			expect(await userEmails(store)).toEqual([])
		} finally {
			await store.close()
		}
	})

	test("allows sign-up for a listed address", async () => {
		const store = await createTestDb()
		try {
			const auth = makeAuth(store.db, parseAllowlist("superaseph@gmail.com"))
			const res = await auth.api.signUpEmail({
				body: { email: "SuperAseph@gmail.com", password: "a-long-enough-password", name: "Myth" },
			})
			expect(res.user.email.toLowerCase()).toBe("superaseph@gmail.com")
			expect(await userEmails(store)).toHaveLength(1)
		} finally {
			await store.close()
		}
	})

	test("an empty allowlist lets nobody in", async () => {
		const store = await createTestDb()
		try {
			const auth = makeAuth(store.db, [])
			await expect(
				auth.api.signUpEmail({
					body: { email: "superaseph@gmail.com", password: "a-long-enough-password", name: "M" },
				}),
			).rejects.toThrow()
			expect(await userEmails(store)).toEqual([])
		} finally {
			await store.close()
		}
	})

	test("the Google provider is registered only when credentials are supplied", () => {
		// A provider with an empty client secret would fail later at the token
		// exchange with a confusing 401 from Google, so half a config must mean
		// "no provider", not "a broken one".
		const withGoogle = buildAuth({
			db: {} as never,
			secret: SECRET,
			baseURL: BASE,
			trustedOrigins: [BASE],
			allowedEmails: [],
			google: { clientId: "id.apps.googleusercontent.com", clientSecret: "secret" },
		})
		expect(withGoogle.options.socialProviders?.google).toBeDefined()

		const without = buildAuth({
			db: {} as never,
			secret: SECRET,
			baseURL: BASE,
			trustedOrigins: [BASE],
			allowedEmails: [],
		})
		expect(without.options.socialProviders?.google).toBeUndefined()
	})

	test("isEmailAllowed agrees with what the hook admits", async () => {
		// Guards against the two drifting: the helper is used for the per-request
		// session check while the hook is what actually blocks creation.
		const list = parseAllowlist("superaseph@gmail.com")
		expect(isEmailAllowed("superaseph@gmail.com", list)).toBe(true)
		expect(isEmailAllowed("other@example.com", list)).toBe(false)

		const store = await createTestDb()
		try {
			const auth = makeAuth(store.db, list)
			await expect(
				auth.api.signUpEmail({
					body: { email: "other@example.com", password: "a-long-enough-password", name: "O" },
				}),
			).rejects.toThrow()
			await auth.api.signUpEmail({
				body: { email: "superaseph@gmail.com", password: "a-long-enough-password", name: "S" },
			})
			expect(await userEmails(store)).toEqual(["superaseph@gmail.com"])
		} finally {
			await store.close()
		}
	})

	// The dashboard is admin-only: `review.list`, `review.get` and `queue.stats` are
	// all `adminProcedure`. A sign-in that creates a row with the schema default
	// `role=user` therefore "succeeds" into a dashboard that answers 403 to
	// everything — signed in, empty, and silent about why. That is the same shape as
	// the allowlist lockout, so it gets the same treatment: pinned by a test.
	test("an allowlisted account is created as admin, so the dashboard is usable", async () => {
		const store = await createTestDb()
		try {
			const auth = makeAuth(store.db, parseAllowlist("superaseph@gmail.com"))
			await auth.api.signUpEmail({
				body: {
					email: "superaseph@gmail.com",
					password: "a-long-enough-password",
					name: "S",
				},
			})
			expect(await userRoles(store)).toEqual([{ email: "superaseph@gmail.com", role: "admin" }])
		} finally {
			await store.close()
		}
	})

	test("a registration body cannot choose its own role", async () => {
		// `input: false` on the additional field is what makes the hook safe to
		// promote unconditionally: whatever the caller sends, it is ignored.
		const store = await createTestDb()
		try {
			const auth = makeAuth(store.db, parseAllowlist("superaseph@gmail.com"))
			await auth.api.signUpEmail({
				body: {
					email: "superaseph@gmail.com",
					password: "a-long-enough-password",
					name: "S",
					// @ts-expect-error -- not part of the public body type, which is the point
					role: "user",
				},
			})
			expect((await userRoles(store))[0]?.role).toBe("admin")
		} finally {
			await store.close()
		}
	})
})

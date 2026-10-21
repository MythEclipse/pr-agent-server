// The allowlist can lock an operator out of their own dashboard, and does it in the
// least visible way possible: sign-in succeeds (200 + a session cookie), then every
// RPC answers 401 because `resolveSession` re-checks the list. The dashboard renders
// empty. This happened on production with the seeded admin.
//
// These tests pin the boot-time guard that names the mistake, and re-assert the
// property the guard depends on: an admin whose address is not listed really is
// refused, so the guard is not decoration.

import { describe, expect, it } from "vitest"
import { describeAdminLockout } from "../src/infrastructure/auth/admin-lockout.ts"
import { isEmailAllowed, parseAllowlist } from "../src/infrastructure/auth/allowlist.ts"

describe("describeAdminLockout", () => {
	it("stays quiet when the sole admin is on the allowlist", () => {
		const warnings = describeAdminLockout(
			[{ email: "owner@example.com" }],
			parseAllowlist("owner@example.com"),
		)
		expect(warnings).toEqual([])
	})

	it("warns PER LOCKED-OUT ADMIN when the allowlist names someone else entirely", () => {
		// The exact production shape: allowlist says one address, the admin row says
		// another. Sign-in still returns 200, so nothing looks wrong until the UI
		// renders empty.
		const warnings = describeAdminLockout(
			[{ email: "owner@example.com" }],
			parseAllowlist("someone-else@example.com"),
		)
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("owner@example.com")
		expect(warnings[0]).toContain("401")
	})

	it("warns only about the admins actually excluded", () => {
		const warnings = describeAdminLockout(
			[{ email: "kept@example.com" }, { email: "dropped@example.com" }],
			parseAllowlist("kept@example.com"),
		)
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("dropped@example.com")
		expect(warnings.join(" ")).not.toContain("kept@example.com")
	})

	it("says nothing when there are no admins at all (fresh install)", () => {
		// A missing admin is `seed`'s problem to report; warning here would fire on
		// every pre-seed boot and train the operator to ignore the line.
		expect(describeAdminLockout([], parseAllowlist("owner@example.com"))).toEqual([])
	})

	it("matches case-insensitively, like the allowlist it feeds on", () => {
		expect(
			describeAdminLockout([{ email: "Owner@Example.com" }], parseAllowlist(" owner@example.COM ")),
		).toEqual([])
	})
})

describe("the refusal the guard is warning about", () => {
	it("refuses an admin address that is not listed", () => {
		// Stated as a fact so the warning above cannot drift into fiction.
		expect(isEmailAllowed("owner@example.com", parseAllowlist("someone-else@example.com"))).toBe(
			false,
		)
	})

	it("admits it once listed, including alongside others", () => {
		expect(
			isEmailAllowed(
				"owner@example.com",
				parseAllowlist("someone-else@example.com,owner@example.com"),
			),
		).toBe(true)
	})

	it("denies everyone when the list is empty — the fail-closed default", () => {
		expect(isEmailAllowed("owner@example.com", parseAllowlist(""))).toBe(false)
	})
})

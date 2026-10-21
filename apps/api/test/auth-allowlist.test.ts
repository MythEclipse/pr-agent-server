// The allowlist is the authorization boundary for Google sign-in.
//
// Google authenticates any account on the planet. Without this list, "Continue
// with Google" on the login page would hand the review history — every reviewed
// repo, PR number and model response — to whoever clicked it. So these tests are
// about who gets in, and the default must be "nobody".

import { describe, expect, test } from "vitest"
import {
	isEmailAllowed,
	NOT_ALLOWED_MESSAGE,
	normaliseEmail,
	parseAllowlist,
} from "../src/infrastructure/auth/allowlist.ts"

describe("parseAllowlist", () => {
	test("splits on commas and trims", () => {
		expect(parseAllowlist(" superaseph@gmail.com , other@example.com ")).toEqual([
			"superaseph@gmail.com",
			"other@example.com",
		])
	})

	test("lowercases, because emails are case-insensitive", () => {
		// An upper-case entry that failed to match a lower-case Google claim would
		// look like a working allowlist while locking the owner out.
		expect(parseAllowlist("SuperAseph@Gmail.COM")).toEqual(["superaseph@gmail.com"])
	})

	test("drops empty entries instead of allowing the empty string", () => {
		expect(parseAllowlist("a@b.c,,   ,")).toEqual(["a@b.c"])
		expect(parseAllowlist("")).toEqual([])
		expect(parseAllowlist("   ")).toEqual([])
	})

	test("de-duplicates", () => {
		expect(parseAllowlist("a@b.c, A@B.C")).toEqual(["a@b.c"])
	})
})

describe("isEmailAllowed", () => {
	const list = parseAllowlist("superaseph@gmail.com")

	test("allows a listed address", () => {
		expect(isEmailAllowed("superaseph@gmail.com", list)).toBe(true)
	})

	test("allows it regardless of case or surrounding whitespace", () => {
		// The Google claim's casing is not ours to control.
		expect(isEmailAllowed("SuperAseph@Gmail.com", list)).toBe(true)
		expect(isEmailAllowed("  superaseph@gmail.com  ", list)).toBe(true)
	})

	test("denies an address that is not listed", () => {
		expect(isEmailAllowed("someone@else.com", list)).toBe(false)
	})

	test("denies a lookalike address", () => {
		// Substring/prefix matching would be a real vulnerability here: a
		// "superaseph@gmail.com.evil.tld" must not pass because it CONTAINS the
		// allowed address.
		expect(isEmailAllowed("superaseph@gmail.com.evil.tld", list)).toBe(false)
		expect(isEmailAllowed("notsuperaseph@gmail.com", list)).toBe(false)
		expect(isEmailAllowed("superaseph@gmail.co", list)).toBe(false)
	})

	test("an EMPTY allowlist allows nobody", () => {
		// The safe reading. "Unset means allow everyone" would turn a forgotten env
		// var into an open dashboard, which is the failure that matters most.
		expect(isEmailAllowed("superaseph@gmail.com", [])).toBe(false)
		expect(isEmailAllowed("anyone@anywhere.com", [])).toBe(false)
	})

	test("a missing email allows nobody", () => {
		expect(isEmailAllowed(null, list)).toBe(false)
		expect(isEmailAllowed(undefined, list)).toBe(false)
		expect(isEmailAllowed("", list)).toBe(false)
	})
})

describe("NOT_ALLOWED_MESSAGE", () => {
	test("does not disclose whether the account exists or who is allowed", () => {
		// A message naming the operator's address would hand an attacker the exact
		// target to phish, and "no such user" confirms which addresses exist.
		const message = NOT_ALLOWED_MESSAGE.toLowerCase()
		expect(message).not.toContain("@")
		expect(message).not.toContain("does not exist")
		expect(message).not.toContain("no account")
		expect(message).not.toContain("superaseph")
	})
})

describe("normaliseEmail", () => {
	test("trims and lowercases only", () => {
		expect(normaliseEmail("  A@B.CoM  ")).toBe("a@b.com")
	})
})

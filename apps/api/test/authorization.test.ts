// Cross-cutting helpers from skill §2.5, which have their own .test.ts.

import { describe, expect, test } from "vitest"
import { assertRole, hasRole } from "../src/application/shared/authorization.ts"
import {
	type AppError,
	badRequest,
	conflict,
	forbidden,
	internalError,
	notFound,
	unauthorized,
} from "../src/application/shared/errors.ts"
import { toOrpcError } from "../src/presentation/orpc/error-mapping.ts"

describe("hasRole / assertRole", () => {
	test("an admin passes an admin-only check", () => {
		expect(hasRole("admin", ["admin"])).toBe(true)
		expect(() => assertRole("admin", ["admin"])).not.toThrow()
	})

	test("a plain user fails an admin-only check", () => {
		expect(hasRole("user", ["admin"])).toBe(false)
		expect(() => assertRole("user", ["admin"])).toThrow(/requires role admin/)
	})

	test("an anonymous caller has no role at all", () => {
		expect(hasRole(undefined, ["admin"])).toBe(false)
		expect(() => assertRole(undefined, ["admin", "user"])).toThrow()
	})

	test("an unknown role string is not silently treated as admin", () => {
		expect(hasRole("superuser", ["admin"])).toBe(false)
		expect(hasRole("", ["user"])).toBe(false)
	})
})

describe("AppError", () => {
	test("each factory sets its code", () => {
		expect(unauthorized("x").code).toBe("UNAUTHORIZED")
		expect(forbidden("x").code).toBe("FORBIDDEN")
		expect(notFound("x").code).toBe("NOT_FOUND")
		expect(badRequest("x").code).toBe("BAD_REQUEST")
		expect(conflict("x").code).toBe("CONFLICT")
		expect(internalError("x").code).toBe("INTERNAL_ERROR")
	})

	test("is a real Error carrying its message", () => {
		const err = notFound("no such review")
		expect(err).toBeInstanceOf(Error)
		expect(err.name).toBe("AppError")
		expect(err.message).toBe("no such review")
	})
})

describe("toOrpcError", () => {
	test("maps every AppErrorCode to its status", () => {
		const cases: [AppError, number][] = [
			[unauthorized("a"), 401],
			[forbidden("a"), 403],
			[notFound("a"), 404],
			[badRequest("a"), 400],
			[conflict("a"), 409],
			[internalError("a"), 500],
		]
		for (const [err, status] of cases) {
			expect(toOrpcError(err).status).toBe(status)
		}
	})

	test("preserves the code and message", () => {
		const mapped = toOrpcError(forbidden("requires role admin"))
		expect(mapped.code).toBe("FORBIDDEN")
		expect(mapped.data.message).toBe("requires role admin")
	})

	test("an unknown error becomes a 500 rather than leaking", () => {
		const mapped = toOrpcError(new Error("kaboom"))
		expect(mapped.status).toBe(500)
		expect(mapped.code).toBe("INTERNAL_ERROR")
	})

	test("a non-Error throw still maps", () => {
		expect(toOrpcError("just a string").status).toBe(500)
	})
})

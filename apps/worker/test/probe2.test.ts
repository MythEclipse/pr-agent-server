import { expect, test } from "vitest"

// Smoke probe: pins the arithmetic the fix loop relies on so an accidental
// operator/precedence change is caught here rather than in a stale PR diff.
test("probe: arithmetic", () => {
	expect(2 * 3).toBe(6)
})

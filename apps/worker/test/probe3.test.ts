import { expect, test } from "vitest"

// Smoke probe: pins basic arithmetic so an accidental operator or precedence
// change surfaces here rather than deep inside a stale PR diff.
test("probe: arithmetic", () => {
	expect(3 * 3).toBe(9)
})

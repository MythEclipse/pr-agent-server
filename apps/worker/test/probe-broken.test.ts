// Deliberately failing probe: created to verify the fix-until-green loop.
import { expect, test } from "vitest"

test("probe: this assertion is intentionally wrong", () => {
	expect(1 + 1).toBe(3)
})

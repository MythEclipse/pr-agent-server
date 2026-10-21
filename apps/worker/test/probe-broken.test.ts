// Sanity probe for the worker test harness: a trivially true arithmetic
// assertion. It keeps the suite honest about reporting red runs — the probe
// was introduced to verify the fix-until-green loop, and the expectation it
// shipped with (1 + 1 === 3) was simply wrong.
import { expect, test } from "vitest"

test("probe: basic arithmetic holds", () => {
	expect(1 + 1).toBe(2)
})

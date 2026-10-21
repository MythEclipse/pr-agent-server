// Tests for the PR description tool helpers (pure functions).

import { describe, expect, test } from "vitest"
import {
	deriveLabels,
	insertBrAfterXChars,
	parseDescriptionYaml,
	sanitizeDiagram,
} from "../src/legacy/tools/describe.ts"

describe("describe helpers", () => {
	test("deriveLabels from type list", () => {
		expect(deriveLabels({ type: ["Bug fix", "Enhancement"] })).toEqual(["Bug fix", "Enhancement"])
		expect(deriveLabels({ type: "Bug fix, Tests" })).toEqual(["Bug fix", "Tests"])
		expect(deriveLabels({ labels: ["Bug fix"], type: ["Other"] })).toEqual(["Bug fix"])
		expect(deriveLabels({})).toEqual([])
	})

	test("sanitizeDiagram strips fences and rejects non-diagrams", () => {
		expect(sanitizeDiagram("```mermaid\nflowchart LR\n  A --> B\n```")).toBe(
			"flowchart LR\n  A --> B",
		)
		expect(sanitizeDiagram("plain text without diagram")).toBe("")
		expect(sanitizeDiagram("")).toBe("")
		expect(sanitizeDiagram("graph TD\n  A --> B")).toBe("graph TD\n  A --> B")
	})

	test("insertBrAfterXChars wraps long text", () => {
		const long = "a".repeat(80)
		const wrapped = insertBrAfterXChars(long, 70)
		expect(wrapped).toContain("<br>")
		expect(wrapped.replace(/<br>/g, "")).toBe(long)
		// html tags don't count toward the budget
		const withTag = insertBrAfterXChars("<code>abcdef</code>", 70)
		expect(withTag.length).toBe("<code>abcdef</code>".length)
	})
})

describe("describe YAML validation", () => {
	// `runDescribe` used to parse AFTER `callWithFallback` returned and `throw` on
	// failure, so an unparseable-but-HTTP-200 body cost the whole call: no retry on
	// that model, no fallback, no description. The review path had already been
	// fixed via a `validate` hook; describe had not. Model YAML is
	// non-deterministic, so one bad sample must not end the tool.

	test("accepts a fenced YAML body", () => {
		const data = parseDescriptionYaml("```yaml\nlabel: Bug fix\ndescription: x\n```")
		expect(data).not.toBeNull()
		expect(data?.label).toBe("Bug fix")
	})

	test("accepts a bare YAML body", () => {
		const data = parseDescriptionYaml("label: Enhancement\ndescription: y")
		expect(data?.label).toBe("Enhancement")
	})

	test("rejects prose, so the model is retried instead of the tool failing", () => {
		// A validator returning non-null is what moves to a retry / the next model.
		expect(parseDescriptionYaml("Looks fine to me!")).toBeNull()
		expect(parseDescriptionYaml("")).toBeNull()
	})

	test("rejects a scalar body rather than letting the caller crash on it", () => {
		// `loadYaml` returns a scalar for these; the reorder indexes into the
		// result, so they must be rejected here.
		expect(parseDescriptionYaml("42")).toBeNull()
		expect(parseDescriptionYaml('"just a string"')).toBeNull()
	})
})

// The suggestions path discarded failures silently.
//
// `runImprove` split the diff into chunks and parsed each chunk's YAML AFTER
// `callWithFallback` returned. When the parse failed the result was simply not
// pushed — no retry, no error, no fallback. The PR then received a comment
// saying "No suggestions found to improve this PR" for a chunk the model never
// successfully answered for.
//
// That is worse than a visible failure, because the caller cannot tell "the model
// found nothing" from "the model's answer was unusable". Model YAML is
// non-deterministic (the same model and prompt parse on one run and not the
// next), so the fix is to parse inside `validate`: a bad body costs a retry on
// that model, then moves to the fallback chain.
//
// `runImprove` constructs its own GitHubProvider, so the parser is the reachable
// unit; the wiring is asserted by the `validate` tests in llm-fallback.test.ts.
// The distinction this file pins down is the one that caused the silent loss:
// [] means "nothing to suggest", null means "unusable, retry".

import { describe, expect, test } from "vitest"
import { parseSuggestionsYaml } from "../src/legacy/tools/improve.ts"

const VALID = `code_suggestions:
  - relevant_file: src/app.ts
    suggestion_content: Handle the null case
    improved_code: |
      const x = y ?? 0
    one_sentence_summary: Guard the null
    label: Possible bug
    score: 8
`

describe("improve suggestions parsing", () => {
	test("parses a fenced YAML body into suggestions", () => {
		const out = parseSuggestionsYaml("```yaml\n" + VALID + "```")
		expect(out).not.toBeNull()
		expect(out).toHaveLength(1)
		expect(out?.[0]?.relevant_file).toBe("src/app.ts")
		expect(out?.[0]?.score).toBe(8)
	})

	test("parses an unfenced YAML body", () => {
		const out = parseSuggestionsYaml(VALID)
		expect(out).toHaveLength(1)
	})

	test("an empty list is a VALID answer, distinct from a failure", () => {
		// This distinction is the whole point. `[]` must reach the caller so it can
		// honestly say "nothing to suggest"; `null` must trigger a retry.
		const empty = parseSuggestionsYaml("```yaml\ncode_suggestions: []\n```")
		expect(empty).toEqual([])
		expect(empty).not.toBeNull()
	})

	test("prose returns null, not an empty list", () => {
		// The old code collapsed this into "no suggestions" and published that.
		expect(parseSuggestionsYaml("I could not find anything to improve.")).toBeNull()
		expect(parseSuggestionsYaml("")).toBeNull()
	})

	test("a body missing code_suggestions returns null", () => {
		expect(parseSuggestionsYaml("```yaml\nother_key: 1\n```")).toBeNull()
	})

	test("a non-array code_suggestions returns null", () => {
		// A model occasionally emits a single object instead of a list; indexing
		// into it as an array would silently drop it or crash downstream.
		expect(parseSuggestionsYaml("```yaml\ncode_suggestions: nope\n```")).toBeNull()
	})
})

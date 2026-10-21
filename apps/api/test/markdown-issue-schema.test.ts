// REGRESSION: the renderer and the PROMPT must agree on the issue-item schema.
//
// Found 2026-10-21 via asepharyana/GMW#119, whose review body read
// "No key issues identified" at score 95. The renderer was not the whole story:
// it read `{relevant_file, relevant_line, suggestion}` while `prompts/review.ts`
// asks the model for `{relevant_file, issue_header, issue_content, start_line,
// end_line}`. Every item therefore rendered with an EMPTY description —
// "**path:12** — " — so a review that reported a real bug published a blank
// finding, and the worker's safety gate had nothing to read.
//
// The pre-existing tests missed it because their fixtures used the RENDERER's
// shape: they encoded the bug as the contract. These tests use the shape the
// PROMPT actually requests, which is the only shape production can produce.

import { describe, expect, test } from "vitest"
import { convertToMarkdownV2 } from "../src/legacy/core/markdown.ts"
import { REVIEW_SYSTEM_TEMPLATE } from "../src/legacy/prompts/review.ts"

describe("review markdown: current prompt schema", () => {
	// Exactly the fields KeyIssuesComponentLink declares in prompts/review.ts.
	const currentShape = {
		review: {
			score: "70",
			key_issues_to_review: [
				{
					relevant_file: "apps/api/src/users.ts",
					issue_header: "SQL injection",
					issue_content: "ids are interpolated into the query string without parameterisation.",
					start_line: 12,
					end_line: 14,
				},
			],
			security_concerns: "No",
		},
	}

	test("renders the issue BODY, not just the location", () => {
		const md = convertToMarkdownV2(currentShape as never)
		// The whole point: the description must survive.
		expect(md).toContain("SQL injection")
		expect(md).toContain("interpolated into the query string")
	})

	test("renders the line range from start_line/end_line", () => {
		const md = convertToMarkdownV2(currentShape as never)
		expect(md).toContain("apps/api/src/users.ts:12-14")
	})

	test("never emits an em-dash with nothing after it", () => {
		const md = convertToMarkdownV2(currentShape as never)
		// The old bug's exact fingerprint.
		expect(md).not.toMatch(/\*\*[^*]+\*\* — \s*(?:\n|$)/)
	})

	test("a single-line issue renders one number, not a bogus range", () => {
		const md = convertToMarkdownV2({
			review: {
				key_issues_to_review: [
					{
						relevant_file: "a.ts",
						issue_header: "Bug",
						issue_content: "broken",
						start_line: 7,
						end_line: 7,
					},
				],
			},
		} as never)
		expect(md).toContain("a.ts:7**")
		expect(md).not.toContain("7-7")
	})

	test("still renders the OLD {relevant_line, suggestion} shape", () => {
		// Historical rows in `reviews` were written with this shape, and the
		// dashboard replays stored markdown — new code must not break old data.
		const md = convertToMarkdownV2({
			review: {
				key_issues_to_review: [
					{ relevant_file: "b.ts", relevant_line: "21", suggestion: "Close the handle." },
				],
			},
		} as never)
		expect(md).toContain("b.ts:21")
		expect(md).toContain("Close the handle.")
	})

	test("numbers render even when the model emits them as ints", () => {
		const md = convertToMarkdownV2({
			review: {
				key_issues_to_review: [{ relevant_file: "c.ts", issue_content: "x", start_line: 5 }],
			},
		} as never)
		expect(md).toContain("c.ts:5")
	})

	test("an empty list still says so, rather than rendering a blank row", () => {
		const md = convertToMarkdownV2({ review: { key_issues_to_review: [] } } as never)
		expect(md).toContain("No key issues identified")
	})

	test("the PROMPT still declares the fields the renderer now reads", () => {
		// Guards the other direction: if someone renames a field in the prompt
		// without touching the renderer, this trips instead of production.
		for (const field of ["issue_header", "issue_content", "start_line", "end_line"]) {
			expect(REVIEW_SYSTEM_TEMPLATE).toContain(field)
		}
	})
})

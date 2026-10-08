import { describe, expect, test } from "vitest"
import { getModelTokenLimit, loadConfig } from "../src/infrastructure/config/legacy-config.ts"
import {
	EditType,
	type FilePatchInfo,
	getPrDiff,
	getPrMultiDiffs,
} from "../src/legacy/diff/index.ts"

const file = (filename: string, patch: string): FilePatchInfo => ({
	filename,
	baseFile: "a\nb\nc\n",
	headFile: "a\nB\nc\n",
	patch,
	editType: EditType.MODIFIED,
	numPlusLines: 1,
	numMinusLines: 1,
})

describe("getPrDiff language ordering", () => {
	test("main-language files come first when languages are supplied", () => {
		// NOTE: `maxModelTokens: 1500` forces getPrDiff's compressed pass, which is
		// the only pass that emits `## File:` headers — the brief's literal fixture
		// (default cfg, promptTokens 0) takes the extended fast path and returns
		// raw patch text with no filenames, so indexOf() is -1 for BOTH files and
		// the assertion is unsatisfiable even after sorting is wired up.
		// Soft/hard thresholds are pinned to their defaults (1500/1000) so the
		// pass choice cannot depend on ambient PR_AGENT_OUTPUT_* env vars.
		const cfg = {
			...loadConfig(),
			maxModelTokens: 1500,
			outputBufferSoftThreshold: 1500,
			outputBufferHardThreshold: 1000,
		}
		const files = [
			file("docs/readme.md", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"),
			file("src/app.py", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"),
		]
		const { diff } = getPrDiff(files, 0, "claude-opus-5", cfg, { Python: 9000, Markdown: 10 })
		expect(diff.indexOf("src/app.py")).toBeLessThan(diff.indexOf("docs/readme.md"))
	})
})

// Locks the S6 consolidation AT THE CONSUMER: these run diff/budget.ts's own
// `getPrDiff`, so they fail if a private token-limit copy is ever re-added to
// `diff/` (the isolated config assertions below cannot detect that).
describe("diff/ resolves model limits through config.getModelTokenLimit (S6)", () => {
	const cfg = () => ({
		...loadConfig(),
		maxModelTokens: 0,
		customModelMaxTokens: 0,
		outputBufferSoftThreshold: 1500,
		outputBufferHardThreshold: 1000,
	})
	const files = [file("src/app.py", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")]

	test("a model present only in config's superset table gets the extended path", () => {
		// gpt-5 → 200000 in config, so promptTokens 150000 still fits and the file
		// is included. A private copy of the OLD table would fall back to 128000
		// here, exhaust the budget, and return an empty diff with the file listed
		// as remaining — so this test fails if the consolidation is reverted.
		const { diff, remainingFiles } = getPrDiff(files, 150000, "gpt-5", cfg())
		expect(remainingFiles).toEqual([])
		expect(diff.length).toBeGreaterThan(0)
	})

	test("an unknown model falls back to 128000, exhausting the budget", () => {
		const { diff, remainingFiles } = getPrDiff(files, 150000, "some-unknown-model", cfg())
		expect(remainingFiles).toEqual(["src/app.py"])
		expect(diff).toBe("")
	})

	// diff/multi.ts is the second getModelTokenLimit consumer; cover it too, so a
	// private table re-added there alone cannot slip through.
	test("getPrMultiDiffs uses the same config limit", () => {
		const fits = getPrMultiDiffs(files, 150000, "gpt-5", cfg(), 3)
		expect(fits.chunks[0].includes("## File:")).toBe(false)

		const over = getPrMultiDiffs(files, 150000, "some-unknown-model", cfg(), 3)
		expect(over.chunks[0].includes("## File:")).toBe(true)
	})
})

// Locks the S6 consolidation: diff/budget.ts + diff/multi.ts now use
// getModelTokenLimit from config, which is a strict superset of the deleted
// private copy. These pin the shared table + fallback + clamp behaviour.
describe("getModelTokenLimit parity (S6 consolidation)", () => {
	const unlimitedCfg = () => ({
		...loadConfig(),
		maxModelTokens: 0,
		customModelMaxTokens: 0,
	})

	test("known models use the shared table", () => {
		const cfg = unlimitedCfg()
		expect(getModelTokenLimit("claude-opus-5", cfg)).toBe(1000000)
		expect(getModelTokenLimit("claude-haiku-4-5-20251001", cfg)).toBe(200000)
	})

	test("unknown model falls back to 128000 when no custom max is set", () => {
		expect(getModelTokenLimit("some-unknown-model", unlimitedCfg())).toBe(128000)
	})

	test("cfg.maxModelTokens still clamps a known model down", () => {
		const cfg = { ...loadConfig(), maxModelTokens: 200, customModelMaxTokens: 0 }
		expect(getModelTokenLimit("claude-opus-5", cfg)).toBe(200)
	})
})

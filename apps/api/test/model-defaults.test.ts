// The model defaults, pinned.
//
// WHY THIS FILE EXISTS. The default was `claude-opus-5`, and the gateway this
// config points at stopped serving that name entirely — it is absent from
// `GET /v1/models` and answers HTTP 400 on `/v1/chat/completions`. Nothing in
// the code failed: `loadConfig()` returned a plausible string, the request went
// out, and every review died on the first call before falling through the
// fallback chain. A default naming a retired model is invisible to typecheck,
// to lint and to any test that does not assert the literal.
//
// So these assert the LITERAL. They are not checking that a constant is defined
// — they are the only place that records which names the gateway still serves.

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { getModelTokenLimit, loadConfig } from "../src/infrastructure/config/legacy-config.ts"

/** Every env var `loadConfig` reads that this file pins. */
const KEYS = [
	"PR_AGENT_MODEL",
	"PR_AGENT_MODEL_REVIEW",
	"PR_AGENT_MODEL_DESCRIBE",
	"PR_AGENT_MODEL_IMPROVE",
	"PR_AGENT_FALLBACK_MODELS",
] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
	saved = {}
	for (const k of KEYS) {
		saved[k] = process.env[k]
		delete process.env[k]
	}
})

afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k]
		else process.env[k] = saved[k]
	}
})

describe("model defaults", () => {
	test("the review model defaults to claude-sonnet-5-5", () => {
		expect(loadConfig().model).toBe("claude-sonnet-5-5")
	})

	// All three task-specific models must agree with `model`. They are read
	// independently, so one of them can drift back to a dead name while the
	// others stay correct — and the command that drifts is the one nobody
	// notices until it fails.
	test("describe, improve and review share the default", () => {
		const cfg = loadConfig()
		expect(cfg.modelReview).toBe("claude-sonnet-5-5")
		expect(cfg.modelDescribe).toBe("claude-sonnet-5-5")
		expect(cfg.modelImprove).toBe("claude-sonnet-5-5")
	})

	// A fallback the gateway does not serve is worse than no fallback: the
	// whole chain 400s and the operator sees "All models failed" with no hint
	// that the names were the problem.
	test("no fallback names a model the gateway retired", () => {
		const retired = ["claude-opus-5", "claude-sonnet-5"]
		for (const m of loadConfig().fallbackModels) expect(retired).not.toContain(m)
	})

	test("an explicit env override still wins", () => {
		process.env.PR_AGENT_MODEL = "ATLAS"
		expect(loadConfig().model).toBe("ATLAS")
	})
})

describe("token limits for the 5.5 generation", () => {
	// These models have a 1M window. Falling through to `customModelMaxTokens`
	// (128k) does not error — it silently compresses every PR diff eight times
	// earlier than necessary, which reads as "the reviewer misses context".
	test("claude-sonnet-5-5 is a 1M-token model", () => {
		expect(getModelTokenLimit("claude-sonnet-5-5", loadConfig())).toBe(1000000)
	})

	test("claude-opus-5-5 is a 1M-token model", () => {
		expect(getModelTokenLimit("claude-opus-5-5", loadConfig())).toBe(1000000)
	})

	// The retired names stay in the table on purpose: an operator who pins one
	// via env gets the right window rather than a silent 128k clamp.
	test("the retired names still resolve to their real window", () => {
		expect(getModelTokenLimit("claude-opus-5", loadConfig())).toBe(1000000)
		expect(getModelTokenLimit("claude-sonnet-5", loadConfig())).toBe(1000000)
	})
})

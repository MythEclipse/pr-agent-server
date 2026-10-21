// REGRESSION: a substituted model must be RECORDED, not silently accepted.
//
// Found 2026-10-21 from asepharyana/GMW#119: the dashboard said
// `Model: claude-sonnet-5` for a review body that read "No key issues
// identified" at score 95. The model field was a lie.
//
// The gateway (9router) defines `combos` rows NAMED after Claude models whose
// chains are free-tier models:
//
//   claude-sonnet-5 -> [oc/cat-jam-free, oc/space-bunny-free, ...]
//   claude-opus-5   -> [oc/deepseek-v4.1-flash-free, oc/cat-jam-free, ...]
//
// and its DB holds ZERO `anthropic` provider connections. So every request for a
// Claude model was answered by a free model, and nothing anywhere said so: the
// response was HTTP 200 with `"model": "cat-jam-free"`, while the code recorded
// only the name it had ASKED for.
//
// This is an audit-integrity bug, not a formatting one: the operator read
// "claude-sonnet-5" and drew conclusions about a model that never ran.

import { describe, expect, test } from "vitest"
import type { Config } from "../src/infrastructure/config/legacy-config.ts"
import { type ChatResult, callWithFallback } from "../src/infrastructure/llm/llm.ts"

const cfg = {} as Config

/** A call stub that reports whatever `served` says it produced. */
const stub =
	(served: string | undefined, content = "review:\n  score: 90\n") =>
	async (): Promise<ChatResult> => ({ content, finishReason: "stop", servedModel: served })

describe("callWithFallback: served-model attribution", () => {
	test("propagates the served model when the endpoint substitutes", async () => {
		const r = await callWithFallback({
			models: ["claude-sonnet-5"],
			system: "s",
			user: "u",
			cfg,
			call: stub("cat-jam-free"),
		})
		// What we asked for is preserved...
		expect(r.model).toBe("claude-sonnet-5")
		// ...and what actually answered is available separately.
		expect(r.servedModel).toBe("cat-jam-free")
	})

	test("served model equals requested when the endpoint honours it", async () => {
		const r = await callWithFallback({
			models: ["claude-sonnet-5"],
			system: "s",
			user: "u",
			cfg,
			call: stub("claude-sonnet-5"),
		})
		expect(r.servedModel).toBe("claude-sonnet-5")
	})

	test("undefined when the endpoint omits the model field", async () => {
		// Some OpenAI-compatible servers do not echo `model`; that must not
		// invent an attribution.
		const r = await callWithFallback({
			models: ["claude-sonnet-5"],
			system: "s",
			user: "u",
			cfg,
			call: stub(undefined),
		})
		expect(r.servedModel).toBeUndefined()
		expect(r.model).toBe("claude-sonnet-5")
	})

	test("the substituted model on a FALLBACK is reported, not the first model", async () => {
		// `callWithFallback` gives each model `retries + 1` attempts (default 2),
		// so "primary" must be rejected on ALL of its attempts before the loop
		// moves on. Key the rejection to the model, not to a call count.
		const r = await callWithFallback({
			models: ["primary", "fallback"],
			system: "s",
			user: "u",
			cfg,
			validate: (_content, model) => (model === "primary" ? "unusable" : null),
			call: async ({ model }) => ({
				content: "review:\n  score: 90\n",
				finishReason: "stop",
				servedModel: model === "fallback" ? "big-pickle" : "cat-jam-free",
			}),
		})
		expect(r.model).toBe("fallback")
		expect(r.servedModel).toBe("big-pickle")
	})
})

// Tests for the retry-per-model LLM caller (callWithFallback).

import { describe, expect, test } from "vitest"
import { loadConfig } from "../src/infrastructure/config/legacy-config.ts"
import { callWithFallback } from "../src/infrastructure/llm/llm.ts"

const cfg = loadConfig()

describe("callWithFallback", () => {
	test("retries a transient failure then succeeds on the same model", async () => {
		let n = 0
		const fake = async () => {
			n++
			if (n < 3) throw new Error("LLM request failed (503): upstream busy")
			return {
				content: "ok",
				finishReason: "stop",
				usage: { promptTokens: 1, completionTokens: 1 },
			}
		}
		const r = await callWithFallback({
			models: ["m1"],
			system: "s",
			user: "u",
			cfg,
			retries: 2,
			call: fake,
		})
		expect(r.content).toBe("ok")
		expect(r.model).toBe("m1")
		expect(n).toBe(3)
	})

	test("moves to the next model when the first keeps failing", async () => {
		const seen: string[] = []
		const fake = async (o: { model: string }) => {
			seen.push(o.model)
			if (o.model === "m1") throw new Error("LLM request failed (500): boom")
			return { content: "ok2", finishReason: "stop", usage: {} }
		}
		const r = await callWithFallback({
			models: ["m1", "m2"],
			system: "s",
			user: "u",
			cfg,
			retries: 0,
			call: fake,
		})
		expect(r.model).toBe("m2")
		expect(seen).toEqual(["m1", "m2"])
	})

	test("does not retry a 4xx client error", async () => {
		let n = 0
		const fake = async () => {
			n++
			throw new Error("LLM request failed (400): bad model")
		}
		await expect(
			callWithFallback({ models: ["m1"], system: "s", user: "u", cfg, retries: 3, call: fake }),
		).rejects.toThrow(/All models failed/)
		expect(n).toBe(1)
	})

	test("retries Bun's real connection-refused and timeout texts (isTransient)", async () => {
		// Regression lock for the fix: Bun/undici raises these exact messages,
		// which the original isTransient regex did not classify as transient —
		// so no backoff happened on dead upstreams.
		for (const msg of [
			"Unable to connect. Is the computer able to access the url?",
			"The operation timed out.",
			"The operation was aborted.",
			"fetch failed",
		]) {
			let n = 0
			const fake = async () => {
				n++
				if (n < 2) throw new Error(msg)
				return { content: "ok", finishReason: "stop", usage: {} }
			}
			const r = await callWithFallback({
				models: ["m1"],
				system: "s",
				user: "u",
				cfg,
				retries: 2,
				call: fake,
			})
			expect(r.content).toBe("ok")
			expect(n).toBe(2) // retried once, then succeeded
		}
	})

	// THE FAILURE THIS EXISTS FOR: a 200 with an unusable BODY. Without a
	// validator the loop returned that body as success, so the fallback models
	// were never tried and a single bad sample failed the whole review — even
	// though the outputs are non-deterministic and a later model would very
	// likely have answered cleanly.
	test("an unusable body advances to the next model instead of ending the call", async () => {
		const seen: string[] = []
		const fake = async (o: { model: string }) => {
			seen.push(o.model)
			return {
				content: o.model === "m1" ? "```yaml\nreview:\n  bad" : "review:\n  score: 1\n",
				finishReason: "stop",
				usage: {},
			}
		}
		const r = await callWithFallback({
			models: ["m1", "m2"],
			system: "s",
			user: "u",
			cfg,
			retries: 0, // one attempt per model, so the model sequence is exact
			call: fake,
			validate: (content) => (content.includes("bad") ? "unparseable" : null),
		})
		expect(r.model).toBe("m2")
		expect(seen).toEqual(["m1", "m2"])
	})

	test("a validator that THROWS rejects the response rather than crashing", async () => {
		const seen: string[] = []
		const fake = async (o: { model: string }) => {
			seen.push(o.model)
			return { content: "x", finishReason: "stop", usage: {} }
		}
		const r = await callWithFallback({
			models: ["m1", "m2"],
			system: "s",
			user: "u",
			cfg,
			retries: 0,
			call: fake,
			validate: (_content, model) => {
				if (model === "m1") throw new Error("assertion blew up")
				return null
			},
		})
		expect(r.model).toBe("m2")
	})

	test("a rejected body keeps its retries before moving on", async () => {
		// The outputs are non-deterministic, so re-asking the SAME model is a real
		// chance of success — not just the next model.
		let n = 0
		const fake = async () => {
			n++
			return {
				content: n < 3 ? "```yaml\nreview:\n  bad" : "review:\n  score: 1\n",
				finishReason: "stop",
				usage: {},
			}
		}
		const r = await callWithFallback({
			models: ["m1"],
			system: "s",
			user: "u",
			cfg,
			retries: 2,
			call: fake,
			validate: (c) => (c.includes("bad") ? "unparseable" : null),
		})
		expect(r.model).toBe("m1")
		expect(n).toBe(3)
	})

	test("when every model is rejected, the error names each reason", async () => {
		const fake = async () => ({
			content: "```yaml\nreview:\n  bad",
			finishReason: "stop",
			usage: {},
		})
		await expect(
			callWithFallback({
				models: ["m1", "m2"],
				system: "s",
				user: "u",
				cfg,
				retries: 0,
				call: fake,
				validate: () => "failed to parse review response into markdown",
			}),
		).rejects.toThrow(/rejected: m1.*failed to parse.*m2.*failed to parse/s)
	})

	// The 58-of-58 production failure, as a regression lock.
	//
	// Every review failed with `Empty content in model response (finish_reason:
	// tool_calls)` across 7 days and 10 PRs. The model fabricated a `shell` tool
	// call that the request never offered, so `content` was empty. Two separate
	// defects had to be fixed, and these tests pin both:
	//
	//   1. the REQUEST must forbid tool calls (`tool_choice: "none"`);
	//   2. an empty body must get the same model RETRIED, because it is
	//      non-deterministic — measured 3/3 empty on one batch, 0/3 after the fix.
	test("retries an empty response on the SAME model instead of skipping it", async () => {
		// Without this, `break` fell through to the next model and one unlucky
		// sample ended it — so the sum of a few unlucky samples was a dead review.
		let n = 0
		const fake = async () => {
			n++
			if (n < 3) throw new Error("Empty content in model response (finish_reason: tool_calls)")
			return { content: "review: ok", finishReason: "stop", usage: {} }
		}
		const r = await callWithFallback({
			models: ["m1"],
			system: "s",
			user: "u",
			cfg,
			retries: 2,
			call: fake,
		})
		expect(r.content).toBe("review: ok")
		expect(r.model).toBe("m1")
		expect(n).toBe(3) // two empty bodies retried, third answered
	})

	test("an empty response is retried, not misread as a client error", async () => {
		// A persistent empty body must still exhaust the model and move on to the
		// fallback — the retry is bounded, not an infinite loop.
		const calls: string[] = []
		const fake = async (o: { model: string }) => {
			calls.push(o.model)
			if (o.model === "m1")
				throw new Error("Empty content in model response (finish_reason: tool_calls)")
			return { content: "review: ok", finishReason: "stop", usage: {} }
		}
		const r = await callWithFallback({
			models: ["m1", "m2"],
			system: "s",
			user: "u",
			cfg,
			retries: 1,
			call: fake,
		})
		expect(r.model).toBe("m2")
		// 2 attempts on m1 (initial + 1 retry), then m2 once.
		expect(calls).toEqual(["m1", "m1", "m2"])
	})

	test("tool_choice:none is sent, so the model cannot fabricate a tool call", async () => {
		// The request-level half of the fix. `tools: []` alone did NOT work
		// (2 of 3 still empty); the explicit tool_choice is what the endpoint
		// honours. Asserting on the outgoing body is the only way to lock this —
		// the bug is invisible in the response shape we normally inspect.
		let seen: Record<string, unknown> | null = null
		const originalFetch = globalThis.fetch
		globalThis.fetch = (async (
			_url: string | URL | Request,
			init?: { body?: string },
		): Promise<Response> => {
			seen = JSON.parse(init?.body ?? "{}") as Record<string, unknown>
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "review: ok" }, finish_reason: "stop" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)
		}) as typeof fetch
		try {
			await callWithFallback({ models: ["m1"], system: "s", user: "u", cfg, retries: 0 })
		} finally {
			globalThis.fetch = originalFetch
		}
		expect(seen).not.toBeNull()
		expect(seen).toMatchObject({ tool_choice: "none", stream: false })
		// No tools are offered at all — the flag is the guard, not an empty list.
		expect(seen).not.toHaveProperty("tools")
	})
})

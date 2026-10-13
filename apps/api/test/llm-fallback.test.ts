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
})

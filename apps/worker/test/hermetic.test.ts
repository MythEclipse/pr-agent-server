/**
 * Tests for the test-egress guard and environment strip.
 *
 * These are the regression tests for the 2026-10-19 `#notif` spam: 120 Discord
 * embeds whose content was `t` / `l` — the literals from `discord.test.ts` —
 * posted to the live channel by this very suite. The mechanism had three parts
 * (a two-source webhook resolver, an env-only leak, and a notifier that swallows
 * every failure), so each part gets an assertion here rather than trusting that
 * the setup file "just works".
 */
import { afterEach, describe, expect, test } from "vitest"
import { installEgressGuard } from "./helpers/hermetic.ts"

/** Every test here swaps `fetch`, so the original is restored unconditionally. */
const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

describe("test egress guard", () => {
	test("refuses a non-loopback URL instead of sending it", async () => {
		const blocked = installEgressGuard()

		// A real Discord webhook host, which is what leaked. The guard must
		// reject without any DNS or TCP attempt.
		await expect(
			fetch("https://discord.com/api/webhooks/123/abc", { method: "POST" }),
		).rejects.toThrow(/egress guard/)
		expect(blocked).toHaveLength(1)
		expect(blocked[0]?.url).toBe("https://discord.com/api/webhooks/123/abc")
		// The entry is claimed by this test, so the setup file's afterAll must not
		// report it as an unexamined leak.
		blocked.length = 0
	})

	test("allows loopback, which is what the suites' own stubs use", async () => {
		const blocked = installEgressGuard()

		// No listener needed: the assertion is that the guard DELEGATES for
		// loopback rather than blocking, and a stub proves the delegation.
		const calls: string[] = []
		const withStub = () => {
			globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
				calls.push(String(input))
				return Promise.resolve(new Response(null, { status: 204 }))
			}) as typeof fetch
		}
		withStub()
		const guard = installEgressGuard()

		await fetch("http://127.0.0.1:9999/api/webhooks/x", { method: "POST" })
		expect(guard).toHaveLength(0)
		expect(calls).toEqual(["http://127.0.0.1:9999/api/webhooks/x"])
		void blocked
	})

	test("refuses an unparseable URL", async () => {
		const blocked = installEgressGuard()

		// The safe direction when the guard cannot classify what it was handed:
		// passing it through to the real fetch is the case this exists to stop.
		await expect(fetch("not a url", { method: "POST" })).rejects.toThrow(/egress guard/)
		expect(blocked).toHaveLength(1)
		blocked.length = 0
	})
})

describe("hermetic environment", () => {
	// The strip is what actually fixes the leak: with DISCORD_WEBHOOK_URL gone,
	// `opsWebhookUrl()` can only return the temp-HERMES_HOME value a test set.
	test("the setup file strips the live notification variables", () => {
		expect(process.env.DISCORD_WEBHOOK_URL).toBeUndefined()
		expect(process.env.DISCORD_ALERT_WEBHOOK_URL).toBeUndefined()
	})

	// Cross-test isolation: a value set here must be gone in the next test, which
	// is what `beforeEach(stripLiveEnv)` in the setup file buys.
	test("sets a live URL, which the next test must not see", () => {
		process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/late/leak"
		expect(process.env.DISCORD_WEBHOOK_URL).toBeDefined()
	})

	test("the variables are stripped again after a previous test set one", () => {
		expect(process.env.DISCORD_WEBHOOK_URL).toBeUndefined()
	})
})

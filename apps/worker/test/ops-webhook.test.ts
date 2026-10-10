import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { opsWebhookUrl } from "../src/ops-webhook.ts"

// Hermetic by construction: point HERMES_HOME at a temp dir holding a FAKE
// pr-agent-ops URL. The real ~/.hermes/.ops-webhooks.json holds a LIVE Discord
// webhook, so reading it from a test would depend on a secret existing on the
// host and risk posting to the real channel.
const FAKE_WEBHOOK = "https://discord.invalid/api/webhooks/fake/pr-agent-ops"
const FAKE_ENV_WEBHOOK = "https://discord.invalid/api/webhooks/fake/from-env"
let fakeHome = ""
let realHermesHome: string | undefined
let realDiscordWebhookUrl: string | undefined

beforeEach(() => {
	fakeHome = mkdtempSync(join(tmpdir(), "ops-webhook-home-"))
	realHermesHome = process.env.HERMES_HOME
	realDiscordWebhookUrl = process.env.DISCORD_WEBHOOK_URL
	process.env.HERMES_HOME = fakeHome
	// Cleared per-test so the developer's own export cannot leak into a result.
	delete process.env.DISCORD_WEBHOOK_URL
})

afterEach(() => {
	if (realHermesHome === undefined) delete process.env.HERMES_HOME
	else process.env.HERMES_HOME = realHermesHome
	if (realDiscordWebhookUrl === undefined) delete process.env.DISCORD_WEBHOOK_URL
	else process.env.DISCORD_WEBHOOK_URL = realDiscordWebhookUrl
})

describe("opsWebhookUrl", () => {
	test("reads the URL from the ops-webhook config under HERMES_HOME", () => {
		writeFileSync(
			join(fakeHome, ".ops-webhooks.json"),
			JSON.stringify({ "pr-agent-ops": FAKE_WEBHOOK }),
		)
		expect(opsWebhookUrl()).toBe(FAKE_WEBHOOK)
	})

	// Regression guard for the silent-drop bug: the worker runs as pr-agent with
	// HOME=/var/lib/pr-agent-server, where no config file exists. With only the
	// config-file lookup, every per-tick ops report was discarded untraced.
	test("falls back to DISCORD_WEBHOOK_URL when no config file exists", () => {
		process.env.DISCORD_WEBHOOK_URL = FAKE_ENV_WEBHOOK
		expect(opsWebhookUrl()).toBe(FAKE_ENV_WEBHOOK)
	})

	// The config file wins so a test that redirects HERMES_HOME to a fake dir
	// can never post to a live channel, even when DISCORD_WEBHOOK_URL is set.
	test("prefers the config file over DISCORD_WEBHOOK_URL", () => {
		writeFileSync(
			join(fakeHome, ".ops-webhooks.json"),
			JSON.stringify({ "pr-agent-ops": FAKE_WEBHOOK }),
		)
		process.env.DISCORD_WEBHOOK_URL = FAKE_ENV_WEBHOOK
		expect(opsWebhookUrl()).toBe(FAKE_WEBHOOK)
	})

	test("falls back when the config file is absent, malformed, or not an object", () => {
		process.env.DISCORD_WEBHOOK_URL = FAKE_ENV_WEBHOOK

		expect(opsWebhookUrl()).toBe(FAKE_ENV_WEBHOOK) // missing file

		writeFileSync(join(fakeHome, ".ops-webhooks.json"), "{not json")
		expect(opsWebhookUrl()).toBe(FAKE_ENV_WEBHOOK)

		writeFileSync(join(fakeHome, ".ops-webhooks.json"), JSON.stringify(["a"]))
		expect(opsWebhookUrl()).toBe(FAKE_ENV_WEBHOOK)

		writeFileSync(join(fakeHome, ".ops-webhooks.json"), JSON.stringify({ other: "x" }))
		expect(opsWebhookUrl()).toBe(FAKE_ENV_WEBHOOK)
	})

	// Both sources are best-effort by contract: a tick must never die because its
	// notifier could not find a URL.
	test("returns empty string when no source yields a URL", () => {
		expect(opsWebhookUrl()).toBe("")
	})

	// A non-string value must not leak into fetch() as e.g. "[object Object]".
	test("ignores a non-string config value", () => {
		writeFileSync(
			join(fakeHome, ".ops-webhooks.json"),
			JSON.stringify({ "pr-agent-ops": { url: FAKE_WEBHOOK } }),
		)
		expect(opsWebhookUrl()).toBe("")
	})
})

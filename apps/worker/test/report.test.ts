import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Report } from "../src/report.ts"

// Hermetic by construction: point HERMES_HOME at a temp dir holding a FAKE
// pr-agent-ops URL, and stub fetch. The real ~/.hermes/.ops-webhooks.json holds a
// LIVE Discord webhook, so reading it from a test would (a) depend on a secret
// existing on the host — failing on any other machine or CI runner — and (b)
// risk posting to the real channel.
const FAKE_WEBHOOK = "https://discord.invalid/api/webhooks/fake/pr-agent-ops"
let fakeHome = ""
let realHermesHome: string | undefined
let realFetch: typeof globalThis.fetch

beforeEach(() => {
	fakeHome = mkdtempSync(join(tmpdir(), "report-home-"))
	writeFileSync(
		join(fakeHome, ".ops-webhooks.json"),
		JSON.stringify({ "pr-agent-ops": FAKE_WEBHOOK }),
	)
	realHermesHome = process.env.HERMES_HOME
	process.env.HERMES_HOME = fakeHome
	realFetch = globalThis.fetch
})

afterEach(() => {
	globalThis.fetch = realFetch
	if (realHermesHome === undefined) delete process.env.HERMES_HOME
	else
		process.env.HERMES_HOME = realHermesHome
		// `isTTY` is typed `boolean`; tests toggle it, so restore through a cast.
	;(process.stdin as { isTTY?: boolean }).isTTY = undefined
})

type Call = { url: string; init: RequestInit | undefined }

/** Rejecting fetch, typed as the real global (which carries a `preconnect`). */
const rejectingFetch = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch

function stubFetch(): Call[] {
	const calls: Call[] = []
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init })
		return Promise.resolve(new Response("ok", { status: 204 }))
	}) as typeof fetch
	return calls
}

const noTty = () => {
	process.stdin.isTTY = false
}

describe("Report", () => {
	// A rejected flush surfaces as an unhandled rejection and can kill the cron
	// tick; the Python contract is that flush never raises and never blocks.
	test("flush resolves with an empty buffer and sends nothing", async () => {
		const calls = stubFetch()
		noTty()
		await expect(new Report().flush()).resolves.toBeUndefined()
		expect(calls).toHaveLength(0)
	})

	test("posts the report to the pr-agent-ops webhook with the Python embed shape", async () => {
		const calls = stubFetch()
		noTty()
		const r = new Report()
		r.push("a")
		r.push("b")
		await expect(r.flush()).resolves.toBeUndefined()
		expect(calls).toHaveLength(1)
		// The URL must be the fake one from the temp HERMES_HOME — proving the config
		// path is resolved at call time and this suite can never reach a live host.
		expect(calls[0].url).toBe(FAKE_WEBHOOK)
		const body = JSON.parse(String(calls[0].init?.body))
		expect(body.username).toBe("PR-Agent Ops")
		expect(body.embeds).toHaveLength(1)
		expect(body.embeds[0].title).toBe("🔀 PR Queue Worker Report")
		expect(body.embeds[0].description).toBe("a\nb")
		expect(body.embeds[0].color).toBe(0x5865f2)
	})

	// Discord rejects a description over 4000 chars, which would silently drop the
	// whole run report. Python truncates with report[:4000].
	test("truncates the description to 4000 characters", async () => {
		const calls = stubFetch()
		noTty()
		const r = new Report()
		r.push("x".repeat(5000))
		await r.flush()
		const body = JSON.parse(String(calls[0].init?.body))
		expect(body.embeds[0].description).toHaveLength(4000)
	})

	test("resolves even when the webhook POST rejects", async () => {
		stubFetch()
		globalThis.fetch = rejectingFetch
		noTty()
		const r = new Report()
		r.push("line")
		await expect(r.flush()).resolves.toBeUndefined()
	})

	test("prints to stdout under a TTY and does not POST", async () => {
		const calls = stubFetch()
		process.stdin.isTTY = true
		const log = console.log
		const printed: string[] = []
		console.log = (line: string) => void printed.push(line)
		try {
			const r = new Report()
			r.push("a")
			r.push("b")
			await expect(r.flush()).resolves.toBeUndefined()
		} finally {
			console.log = log
		}
		expect(printed).toEqual(["a\nb"])
		expect(calls).toHaveLength(0)
	})

	// Hermeticity regression guard: the suite must not depend on a real
	// ~/.hermes/.ops-webhooks.json existing on the host (it holds a live secret),
	// and a missing config must still resolve rather than throw.
	test("resolves without sending when the ops-webhook config is missing", async () => {
		process.env.HERMES_HOME = join(fakeHome, "does-not-exist")
		const calls = stubFetch()
		noTty()
		const r = new Report()
		r.push("a")
		await expect(r.flush()).resolves.toBeUndefined()
		expect(calls).toHaveLength(0)
	})

	// Python never cleared BUFFER, but it is a one-shot process. Here a per-tick
	// flush must post only that tick, not the whole history again.
	test("clears the buffer after a flush so ticks do not re-post history", async () => {
		const calls = stubFetch()
		noTty()
		const r = new Report()
		r.push("tick one")
		await r.flush()
		r.push("tick two")
		await r.flush()
		const bodies = calls.map((c) => JSON.parse(String(c.init?.body)).embeds[0].description)
		expect(bodies).toEqual(["tick one", "tick two"])
	})
})

// The legacy routes are contracts, not internals: GitHub, the ops Prometheus
// scraper and the worker all depend on their exact paths and shapes. These
// tests mount them on a bare Hono app and assert every branch, so a refactor
// cannot quietly change what an external caller sees.

import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { ReviewJob } from "../src/application/queue/review-queue.ts"
import { startLegacyRoutes } from "../src/presentation/http/legacy-routes.ts"

const SECRET = "test-secret"

let app: Hono
let enqueued: ReviewJob[]
let analyticsDir: string

beforeEach(() => {
	enqueued = []
	analyticsDir = mkdtempSync(join(tmpdir(), "legacy-routes-"))
	process.env.GITHUB_WEBHOOK_SECRET = SECRET
	process.env.PR_AGENT_ANALYTICS_DIR = analyticsDir
	process.env.DISCORD_WEBHOOK_URL = ""

	app = new Hono()
	startLegacyRoutes(app, {
		queue: {
			enqueue: (job: ReviewJob) => {
				enqueued.push(job)
				return "queued"
			},
		},
	})
})

afterEach(() => {
	rmSync(analyticsDir, { recursive: true, force: true })
	delete process.env.GITHUB_WEBHOOK_SECRET
	delete process.env.PR_AGENT_ANALYTICS_DIR
	delete process.env.DISCORD_WEBHOOK_URL
})

const sign = (body: string): string =>
	`sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`

const prBody = (number: number, draft = false): string =>
	JSON.stringify({
		pull_request: {
			number,
			state: "open",
			draft,
			url: `https://api.github.com/repos/acme/widgets/pulls/${number}`,
		},
	})

describe("legacy routes — /health", () => {
	test("answers with the status/model shape the watchdog expects", async () => {
		const res = await app.request("/health")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { status: string; model: string }
		expect(body.status).toBe("ok")
		expect(typeof body.model).toBe("string")
	})

	test("answers on any method, as the old if-chain did", async () => {
		expect((await app.request("/health")).status).toBe(200)
		expect((await app.request("/health", { method: "POST" })).status).toBe(200)
	})
})

describe("legacy routes — the webhook", () => {
	test("a POST with no signature is 403", async () => {
		const res = await app.request("/api/v1/github_webhooks", { method: "POST", body: "{}" })
		expect(res.status).toBe(403)
	})

	test("a POST with a bad signature is 403 and enqueues nothing", async () => {
		const res = await app.request("/api/v1/github_webhooks", {
			method: "POST",
			body: "{}",
			headers: { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "pull_request" },
		})
		expect(res.status).toBe(403)
		expect(enqueued).toHaveLength(0)
	})

	test("a signed non-pull_request event is ignored with 200", async () => {
		const body = '{"action":"created"}'
		const res = await app.request("/api/v1/github_webhooks", {
			method: "POST",
			body,
			headers: { "x-hub-signature-256": sign(body), "x-github-event": "issue_comment" },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, ignored: true })
		expect(enqueued).toHaveLength(0)
	})

	test("a signed open PR is enqueued", async () => {
		const body = prBody(42)
		const res = await app.request("/api/v1/github_webhooks", {
			method: "POST",
			body,
			headers: { "x-hub-signature-256": sign(body), "x-github-event": "pull_request" },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, triggered: true })
		expect(enqueued).toEqual([{ owner: "acme", repo: "widgets", pr: 42 }])
	})

	test("a draft PR is ignored", async () => {
		const body = prBody(7, true)
		const res = await app.request("/api/v1/github_webhooks", {
			method: "POST",
			body,
			headers: { "x-hub-signature-256": sign(body), "x-github-event": "pull_request" },
		})
		expect(await res.json()).toEqual({ ok: true, ignored: true })
		expect(enqueued).toHaveLength(0)
	})

	test("the legacy root alias still accepts the webhook", async () => {
		const body = prBody(9)
		const res = await app.request("/", {
			method: "POST",
			body,
			headers: { "x-hub-signature-256": sign(body), "x-github-event": "pull_request" },
		})
		expect(res.status).toBe(200)
		expect(enqueued).toHaveLength(1)
	})
})

describe("legacy routes — notify_review", () => {
	test("a POST is accepted", async () => {
		const res = await app.request("/api/v1/notify_review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ repo: "o/r", pr: 1, status: "done", score: "88" }),
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
	})

	test("a non-POST is 405, as the old if-chain returned", async () => {
		expect((await app.request("/api/v1/notify_review")).status).toBe(405)
	})
})

describe("legacy routes — analytics", () => {
	test("/api/metrics returns Prometheus text", async () => {
		const res = await app.request("/api/metrics")
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/plain")
	})

	test("/api/analytics returns the JSON summary shape", async () => {
		const res = await app.request("/api/analytics")
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body).toHaveProperty("total_events")
		expect(body).toHaveProperty("failure_count")
		expect(body).toHaveProperty("recent")
	})
})

describe("legacy routes — the fallthrough", () => {
	test("an unknown path is 404 with the same body as before", async () => {
		const res = await app.request("/definitely-not-a-route")
		expect(res.status).toBe(404)
		expect(await res.json()).toEqual({ error: "not found" })
	})
})

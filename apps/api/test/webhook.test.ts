import { createHmac } from "node:crypto"
import { describe, expect, test } from "vitest"
import { type ReviewJob, ReviewQueue } from "../src/application/queue/review-queue.ts"
import { handleWebhook, type WebhookEnv } from "../src/application/webhook/handle-webhook.ts"
import { loadConfig } from "../src/infrastructure/config/legacy-config.ts"

const env: WebhookEnv = {
	cfg: loadConfig(),
	privateKeyPem: "",
	webhookSecret: "s3cret",
	analyticsDir: "",
	discordWebhookUrl: "",
	discordAlertWebhookUrl: "",
}
const sign = (b: string) => "sha256=" + createHmac("sha256", "s3cret").update(b).digest("hex")
// Real queue with a recording no-op worker; `sink` records the jobs it accepts.
const fakeQueue = (sink: ReviewJob[] = []) =>
	new ReviewQueue({
		run: async (j) => {
			sink.push(j)
		},
	})

describe("webhook", () => {
	test("rejects a bad signature with 403", async () => {
		const r = await handleWebhook(env, "{}", "sha256=deadbeef", "pull_request", fakeQueue())
		expect(r.status).toBe(403)
	})
	test("rejects a missing signature with 403", async () => {
		const r = await handleWebhook(env, "{}", null, "pull_request", fakeQueue())
		expect(r.status).toBe(403)
	})
	test("ignores non-pull_request events with 200", async () => {
		const body = JSON.stringify({ zen: "hi" })
		const r = await handleWebhook(env, body, sign(body), "ping", fakeQueue())
		expect(r).toEqual({ status: 200, body: { ok: true, ignored: true } })
	})
	test("ignores draft PRs", async () => {
		const body = JSON.stringify({
			action: "opened",
			pull_request: {
				number: 5,
				state: "open",
				draft: true,
				url: "https://api.github.com/repos/o/r/pulls/5",
			},
		})
		const r = await handleWebhook(env, body, sign(body), "pull_request", fakeQueue())
		expect(r.body).toEqual({ ok: true, ignored: true })
	})
	test("enqueues an open non-draft PR and answers fast", async () => {
		const jobs: ReviewJob[] = []
		const body = JSON.stringify({
			action: "opened",
			pull_request: {
				number: 7,
				state: "open",
				draft: false,
				url: "https://api.github.com/repos/o/r/pulls/7",
			},
		})
		const r = await handleWebhook(env, body, sign(body), "pull_request", fakeQueue(jobs))
		expect(r.status).toBe(200)
		expect(r.body).toEqual({ ok: true, triggered: true })
		expect(jobs).toEqual([{ owner: "o", repo: "r", pr: 7 }])
	})
})

// The six legacy HTTP routes, mounted onto Hono.
//
// These are NOT oRPC procedures and must not be rewritten as such. GitHub
// posts to /api/v1/github_webhooks with an HMAC-signed raw body and no
// session; the ops box scrapes /api/metrics; the worker calls
// /api/v1/notify_review over loopback. Their paths, response shapes and
// fallthrough behaviour are contracts, preserved verbatim from the Bun server.

import type { Hono } from "hono"
import type { ReviewJob } from "../../application/queue/review-queue.ts"
import { handleWebhook, type WebhookEnv } from "../../application/webhook/handle-webhook.ts"
import { loadConfig } from "../../infrastructure/config/legacy-config.ts"
import { sendDiscord } from "../../infrastructure/notify/discord.ts"
import { analyticsRoutes } from "./analytics.ts"
import { setupCallback } from "./setup.ts"

/** Either queue backend satisfies this. */
interface IEnqueueOnly {
	enqueue(job: ReviewJob): "queued" | "deduped" | Promise<"queued" | "deduped">
}

export interface LegacyRouteDeps {
	queue: IEnqueueOnly
}

export function startLegacyRoutes(app: Hono, deps: LegacyRouteDeps): void {
	const cfg = loadConfig()
	const appDir = process.env.PR_AGENT_APP_DIR || "/var/lib/pr-agent-server"
	const queue = deps.queue

	const fullEnv: WebhookEnv = {
		cfg,
		privateKeyPem: "",
		webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
		analyticsDir: process.env.PR_AGENT_ANALYTICS_DIR || "/var/lib/pr-agent-server/analytics",
		discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",
		discordAlertWebhookUrl: process.env.DISCORD_ALERT_WEBHOOK_URL ?? "",
	}

	// 1. /health — any method, exactly the shape the health watchdog expects.
	app.all("/health", (c) => c.json({ status: "ok", model: cfg.modelReview }))

	// 2. /setup/callback — the GitHub App manifest flow.
	app.all("/setup/callback", async (c) => {
		const result = await setupCallback(new URL(c.req.url), appDir)
		return result ?? c.json({ status: "ok", message: "callback received" })
	})

	// 3. the webhook, on both the manifest path and the legacy root alias.
	const webhook = async (c: {
		json: (b: unknown, s?: never) => Response
		req: { text(): Promise<string>; header(k: string): string | undefined }
	}): Promise<Response> => {
		const body = await c.req.text()
		const sig = c.req.header("x-hub-signature-256") ?? null
		const event = c.req.header("x-github-event") || ""
		const result = await handleWebhook(fullEnv, body, sig, event, queue as never)
		return c.json(result.body, result.status as never)
	}
	app.post("/api/v1/github_webhooks", webhook)
	app.post("/", webhook)

	// 4. the worker's ops notifier. Unauthenticated by design: loopback only,
	// and the worker authenticates to GitHub with the App, not to us.
	app.all("/api/v1/notify_review", async (c) => {
		if (c.req.method !== "POST") {
			return c.json({ ok: false, error: "method not allowed" }, 405)
		}
		try {
			const body = (await c.req.json()) as {
				repo?: string
				pr?: string | number
				status?: string
				summary?: string
				score?: string
				url?: string
			}
			const repo = body.repo || ""
			const prNum = String(body.pr ?? "")
			const status = body.status || "done"
			const summary = String(body.summary || "")
			const score = String(body.score || "")
			const url = String(body.url || "")
			const content =
				`Review ${status} for ${repo}#${prNum}` +
				(score ? ` — score ${score}` : "") +
				`\n${summary}\n${url}`
			if (fullEnv.discordWebhookUrl) {
				void sendDiscord(fullEnv.discordWebhookUrl, content).catch(() => {})
			} else {
				console.log(`[notify] ${repo}#${prNum} ${status} ${score} ${url}`)
			}
			return c.json({ ok: true })
		} catch (e) {
			return c.json({ ok: false, error: String(e) }, 400)
		}
	})

	// 5. Prometheus + the analytics JSON summary, both off the JSONL files.
	const analyticsOr404 = (c: {
		req: { url: string }
		json: (b: unknown, s: 404) => Response
	}): Response =>
		analyticsRoutes(new URL(c.req.url), fullEnv) ?? c.json({ error: "not found" }, 404)
	app.all("/api/metrics", analyticsOr404)
	app.all("/api/analytics", analyticsOr404)

	// 6. The fallthrough. Deliberately NOT app.all("*"): that would swallow
	// /rpc/*, which is mounted after this function by the composition root,
	// and every oRPC call would 404 before reaching its handler. Hono's
	// notFound runs only after every registered route misses, so /rpc/* falls
	// through to the oRPC route registered later and only genuinely unknown
	// paths get this body.
	app.notFound((c) => c.json({ error: "not found" }, 404))
}

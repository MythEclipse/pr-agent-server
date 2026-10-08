// HTTP server: the Node adapter's route table + the in-process review queue
// worker. The route bodies are web-standard Request/Response, so only the host
// changed in P1 (Bun.serve -> @hono/node-server); the paths, the order they are
// tested in, and the response shapes are byte-for-byte the same.

import { readFileSync } from "node:fs"
import { type ServerType, serve } from "@hono/node-server"
import { ReviewQueue } from "../../application/queue/review-queue.ts"
import { notifyReviewFailure, notifyReviewSuccess } from "../../application/review/notify-review.ts"
import { handleWebhook, type WebhookEnv } from "../../application/webhook/handle-webhook.ts"
import { loadConfig } from "../../infrastructure/config/legacy-config.ts"
import { sendDiscord } from "../../infrastructure/notify/discord.ts"
import { runReview } from "../../legacy/tools/review.ts"
import { analyticsRoutes } from "./analytics.ts"
import { setupCallback } from "./setup.ts"

export type AppServer = ServerType

function readPrivateKey(path: string): string {
	try {
		return readFileSync(path, "utf-8")
	} catch {
		return ""
	}
}

export function startServer(env?: Partial<WebhookEnv>): AppServer {
	const cfg = env?.cfg ?? loadConfig()
	const appDir = process.env.PR_AGENT_APP_DIR || "/var/lib/pr-agent-server"
	const privateKeyPem =
		env?.privateKeyPem ??
		(readPrivateKey(process.env.PRIVATE_KEY_PATH || `${appDir}/private-key.pem`) ||
			readPrivateKey(`${appDir}/private-key.pem`) ||
			"")
	const webhookSecret = env?.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? ""
	const analyticsDir =
		env?.analyticsDir ??
		(process.env.PR_AGENT_ANALYTICS_DIR || "/var/lib/pr-agent-server/analytics")
	const discordWebhookUrl = env?.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL ?? ""
	const discordAlertWebhookUrl =
		env?.discordAlertWebhookUrl ?? process.env.DISCORD_ALERT_WEBHOOK_URL ?? ""

	const fullEnv: WebhookEnv = {
		cfg,
		privateKeyPem,
		webhookSecret,
		analyticsDir,
		discordWebhookUrl,
		discordAlertWebhookUrl,
	}

	// One in-process review queue for the lifetime of the server: a webhook burst
	// is deduped per PR and capped at two concurrent reviews, so GitHub gets an
	// immediate 200 while the LLM is not stampeded. `run` owns the notification
	// side-effects (analytics + Discord) on both the success and failure paths.
	const queue = new ReviewQueue({
		concurrency: 2,
		run: (j) =>
			runReview(cfg, j.owner, j.repo, j.pr, privateKeyPem)
				.then((r) => notifyReviewSuccess(fullEnv, j, r))
				.catch((e: unknown) => notifyReviewFailure(fullEnv, j, e)),
	})

	// The route table is a plain fetch handler; @hono/node-server adapts the
	// Node http server to it without touching any branch below.
	const handler = async (req: Request): Promise<Response> => {
		const url = new URL(req.url)
		if (url.pathname === "/health") {
			return Response.json({ status: "ok", model: cfg.modelReview })
		}
		const setup = await setupCallback(url, appDir)
		if (setup) return setup
		if (url.pathname === "/api/v1/github_webhooks" || url.pathname === "/") {
			if (req.method !== "POST") {
				return Response.json({ ok: true })
			}
			const body = await req.text()
			const sig = req.headers.get("x-hub-signature-256")
			const event = req.headers.get("x-github-event") || ""
			const result = await handleWebhook(fullEnv, body, sig, event, queue)
			return Response.json(result.body, { status: result.status })
		}
		if (url.pathname === "/api/v1/notify_review") {
			if (req.method !== "POST") {
				return Response.json({ ok: false, error: "method not allowed" }, { status: 405 })
			}
			try {
				const body = (await req.json()) as {
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
				return Response.json({ ok: true })
			} catch (e) {
				return Response.json({ ok: false, error: String(e) }, { status: 400 })
			}
		}
		const analytics = analyticsRoutes(url, fullEnv)
		if (analytics) return analytics
		return Response.json({ error: "not found" }, { status: 404 })
	}

	const server = serve({ fetch: handler, port: Number(process.env.PORT || 3000) })

	const address = server.address()
	const port =
		typeof address === "object" && address !== null
			? address.port
			: Number(process.env.PORT || 3000)
	console.log(`PR-Agent server listening on :${port}`)
	return server
}

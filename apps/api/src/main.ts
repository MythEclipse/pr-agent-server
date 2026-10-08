// Composition root and entry point (skill §2.6).
//
// Order matters: infrastructure -> use-cases -> router -> Hono app. Nothing
// below this file constructs its own dependencies.
//
// MOUNT ORDER IS LOAD-BEARING. The six legacy routes are mounted BEFORE the
// oRPC handler so their exact paths and response shapes survive unchanged;
// /api/v1/github_webhooks in particular must never become an oRPC procedure,
// because GitHub posts to it with an HMAC-signed raw body and no session.

import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ServerType } from "@hono/node-server"
import { serve } from "@hono/node-server"
import { RPCHandler } from "@orpc/server/fetch"
import type { Context } from "hono"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { requestId } from "hono/request-id"
import { ReviewQueue } from "./application/queue/review-queue.ts"
import { buildUseCases } from "./application/use-cases.ts"
import { buildAuth } from "./infrastructure/auth/better-auth.ts"
import { loadEnv, type TEnv } from "./infrastructure/config/env.ts"
import { loadConfig } from "./infrastructure/config/legacy-config.ts"
import { createDb } from "./infrastructure/db/client.ts"
import { createQueueRepository } from "./infrastructure/db/repositories/queue-repository.ts"
import { createReviewRepository } from "./infrastructure/db/repositories/review-repository.ts"
import { makeDbReviewQueue } from "./infrastructure/queue/db-review-queue.ts"
import { startLegacyRoutes } from "./presentation/http/legacy-routes.ts"
import { buildContext, type TSession } from "./presentation/orpc/context.ts"
import { buildRouter } from "./presentation/routers/index.ts"

export interface StartOptions {
	env?: TEnv
	/** Injected in tests so no listener is bound. */
	skipListen?: boolean
}

export async function startApp(options: StartOptions = {}) {
	const env = options.env ?? loadEnv()
	const cfg = loadConfig()

	// 1. infrastructure
	const { db, close } = createDb(env.DATABASE_URL)
	const reviews = createReviewRepository(db)
	const queueStore = createQueueRepository(db)
	const auth = buildAuth({
		db,
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		trustedOrigins: [env.WEB_ORIGIN],
	})

	// 2. use-cases. The legacy pipeline keeps its original signatures; only the
	// bound dependencies come from here.
	const { runReview } = await import("./legacy/tools/review.ts")
	const useCases = buildUseCases({
		reviews,
		legacy: {
			runReview: (owner, repo, pr) => runReview(cfg, owner, repo, pr, ""),
			runDescribe: async () => {
				throw new Error("describe stays CLI-only")
			},
			runImprove: async () => {
				throw new Error("improve stays CLI-only")
			},
		},
	})

	// 3. router
	const router = buildRouter(useCases)

	// 4. app
	const app = new Hono()
	app.use("*", requestId())
	app.use("*", logger())
	app.use("*", cors({ origin: env.WEB_ORIGIN, credentials: true }))

	// 4a. better-auth handles its own routes under the prefix the web client
	// and the GitHub manifest already expect.
	app.all("/api/auth/*", async (c: Context): Promise<Response> => auth.handler(c.req.raw))

	// 4b. legacy routes: /health, /setup/callback, the webhook, notify,
	// /api/metrics, /api/analytics, and the 404 fallthrough.
	const runJob = async (job: { owner: string; repo: string; pr: number }): Promise<void> => {
		try {
			await useCases.legacy.runReview(job.owner, job.repo, job.pr)
		} catch (err) {
			console.error(`[queue] review FAILED for ${job.owner}/${job.repo}#${job.pr}: ${String(err)}`)
		}
	}

	const queue =
		env.QUEUE_BACKEND === "db"
			? makeDbReviewQueue({ store: queueStore, concurrency: 2, run: runJob })
			: new ReviewQueue({ concurrency: 2, run: runJob })

	startLegacyRoutes(app, { queue })
	if (env.QUEUE_BACKEND === "db") await (queue as { start(): Promise<void> }).start()

	// 4c. oRPC, registered last so it never shadows a legacy path. The context
	// is built per request at the call site, which is where the session cookie
	// is actually readable.
	const resolveSession = async (headers: Headers): Promise<TSession | null> => {
		const result = await auth.api.getSession({ headers })
		if (!result?.user) return null
		return {
			userId: result.user.id,
			email: result.user.email,
			name: result.user.name,
			role: (result.user as { role?: string }).role === "admin" ? "admin" : "user",
		}
	}

	const rpc = new RPCHandler(router)
	app.all("/rpc/*", async (c: Context): Promise<Response> => {
		const context = await buildContext(c.req.raw.headers, {
			useCases,
			reviews,
			queueStore,
			resolveSession,
		})
		// oRPC matches procedures relative to its mount point, so hand it the
		// path with the /rpc prefix removed: /rpc/review/list -> /review/list.
		const url = new URL(c.req.url)
		url.pathname = url.pathname.replace(/^\/rpc/, "") || "/"
		const result = await rpc.handle(new Request(url, c.req.raw), { context })
		if (result.matched) return result.response
		return c.json({ error: "not found" }, 404)
	})

	if (options.skipListen) {
		return { app, close, db, auth, router }
	}

	const server = serve({ fetch: app.fetch, port: env.PORT })
	const address = server.address()
	const port = typeof address === "object" && address !== null ? address.port : env.PORT
	console.log(`PR-Agent API listening on :${port} (queue=${env.QUEUE_BACKEND})`)
	return { app, server: server as ServerType, close, db, auth, router }
}

function isEntrypoint(): boolean {
	const entry = process.argv[1]
	if (!entry) return false
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
	} catch {
		return false
	}
}

if (isEntrypoint()) {
	await startApp()
}

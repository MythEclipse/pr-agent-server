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
import { OpenAPIGenerator } from "@orpc/openapi"
import { OpenAPIHandler } from "@orpc/openapi/fetch"
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
import { resolvePrivateKeyPem } from "./infrastructure/config/private-key.ts"
import { createDb } from "./infrastructure/db/client.ts"
import { createQueueRepository } from "./infrastructure/db/repositories/queue-repository.ts"
import { createReviewRepository } from "./infrastructure/db/repositories/review-repository.ts"
import { makeDbReviewQueue } from "./infrastructure/queue/db-review-queue.ts"
import { startLegacyRoutes } from "./presentation/http/legacy-routes.ts"
import { serveSpa } from "./presentation/http/spa.ts"
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
	//
	// The App private key MUST be resolved here. The pre-migration server read
	// it in legacy-server.ts; this composition root is what the Node cutover
	// actually serves, and it used to pass a literal "" — so every webhook
	// review failed with `[@octokit/auth-app] privateKey option is required`
	// while the key sat readable on disk.
	const privateKeyPem = resolvePrivateKeyPem()
	if (!privateKeyPem) {
		console.warn(
			`[boot] no GitHub App private key found (PR_AGENT_APP_DIR=${process.env.PR_AGENT_APP_DIR ?? "unset"}); reviews will fail until it exists`,
		)
	}
	const { runReview } = await import("./legacy/tools/review.ts")
	const useCases = buildUseCases({
		reviews,
		legacy: {
			runReview: (owner, repo, pr) => runReview(cfg, owner, repo, pr, privateKeyPem),
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
	const openApiHandler = new OpenAPIHandler(router)
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

	// 4d. OpenAPI for the oRPC surface, which is otherwise only reachable as
	// POSTs to /rpc. oRPC 1.x has no apiPrefix/docsUrl options (those were 0.x),
	// so the paths are ours to mount. The handler resolves procedures relative
	// to its own root, so — exactly like /rpc above — the prefix is stripped
	// before it sees the request.
	const spec = await new OpenAPIGenerator().generate(router, {
		info: { title: "PR-Agent API", version: "1.0.0" },
	})
	const mountDocs = async (c: Context): Promise<Response> => {
		const url = new URL(c.req.url)
		url.pathname = url.pathname.replace(/^\/api\/docs/, "") || "/"
		// GET /api/docs/spec is the spec itself. Checked before the handler,
		// which would otherwise match its own /spec route.
		if (url.pathname === "/spec") return c.json(spec as unknown as Record<string, unknown>)
		const result = await openApiHandler.handle(new Request(url, c.req.raw), {
			context: await buildContext(c.req.raw.headers, {
				useCases,
				reviews,
				queueStore,
				resolveSession,
			}),
		})
		if (result.matched) return result.response
		return c.html(docsPage("/api/docs/spec"))
	}
	app.all("/api/docs", mountDocs)
	app.all("/api/docs/*", mountDocs)

	// 4e. The built dashboard, served from WEB_DIST_PATH. LAST, deliberately:
	// its app.get("*") is a catch-all, and Hono matches in registration order,
	// so registering this before /api/docs would hand every docs request to
	// index.html. A request for a real file wins; anything else falls through
	// to index.html for the client-side router.
	if (env.WEB_DIST_PATH) serveSpa(app, env.WEB_DIST_PATH)

	if (options.skipListen) {
		return { app, close, db, auth, router }
	}

	const server = serve({ fetch: app.fetch, port: env.PORT })
	const address = server.address()
	const port = typeof address === "object" && address !== null ? address.port : env.PORT
	console.log(`PR-Agent API listening on :${port} (queue=${env.QUEUE_BACKEND})`)
	return { app, server: server as ServerType, close, db, auth, router }
}

/**
 * A dependency-free docs page. It reads the spec with fetch and renders the
 * procedure list itself rather than pulling Swagger UI from a CDN: the API
 * host is often the only reachable host on the box, and an operator debugging
 * the webhook should not need egress to read the spec.
 */
function docsPage(specPath: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PR-Agent API</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  code { background: #f4f4f5; padding: 0.1rem 0.3rem; border-radius: 3px; }
  li { margin: 0.2rem 0; }
  .m { color: #16a34a; font-weight: 600; }
  .err { color: #b91c1c; }
</style>
</head>
<body>
<h1>PR-Agent API</h1>
<p>OpenAPI document: <a href="${specPath}">${specPath}</a></p>
<ul id="ops"><li class="err">loading…</li></ul>
<script type="module">
  const list = document.getElementById("ops")
  try {
    const spec = await (await fetch(${JSON.stringify(specPath)})).json()
    const rows = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item).map((method) => ({ path, method })),
    )
    list.innerHTML = rows.length
      ? rows.map(({ path, method }) => \`<li><span class="m">\${method.toUpperCase()}</span> <code>\${path}</code></li>\`).join("")
      : "<li class="err">no procedures exposed</li>"
  } catch (err) {
    list.innerHTML = \`<li class="err">\${String(err)}</li>\`
  }
</script>
</body>
</html>`
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

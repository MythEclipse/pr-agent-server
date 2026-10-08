// Serve the built SPA from WEB_DIST_PATH.
//
// This is what makes the single-image deploy work: Hono answers /rpc,
// /api/auth and every legacy route itself, and anything else that names a real
// file in the build is served from disk. Only then does an unknown path fall
// through to index.html — that ordering is what lets a deep link like
// /reviews/12 survive a hard refresh instead of 404ing.

import { existsSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"
import type { Hono } from "hono"

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
}

const contentTypeFor = (path: string): string =>
	CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"

export function serveSpa(app: Hono, distPath: string): void {
	const root = resolve(distPath)
	const indexFile = join(root, "index.html")

	// A missing build is a deployment mistake, not a request error: say so once
	// at boot rather than serving a 404 that looks like a routing bug.
	if (!existsSync(indexFile)) {
		console.warn(`[spa] no index.html under ${root} — the dashboard will not load`)
		return
	}

	// Assets are content-hashed by the bundler, so they cache hard. index.html
	// must not, or a deploy would keep serving the previous asset names.
	app.get("/assets/*", async (c) => {
		const asset = await readIfPresent(root, c.req.path)
		if (!asset) return c.notFound()
		return c.body(asset.body, 200, {
			"content-type": asset.contentType,
			"cache-control": "public, max-age=31536000, immutable",
		})
	})

	app.get("*", async (c) => {
		// Never claim an API path. Falling through to index.html here would
		// answer an unknown /api/* with 200 and an HTML body, which hides a
		// typo'd webhook URL and makes /api/health-style probes report healthy.
		// c.notFound() hands it to the app-level notFound handler instead.
		if (c.req.path.startsWith("/api/")) return c.notFound()

		const file = await readIfPresent(root, c.req.path)
		if (file) {
			return c.body(file.body, 200, {
				"content-type": file.contentType,
				"cache-control": "no-cache",
			})
		}
		// No such file: hand the route to the client-side router.
		const html = await readFile(indexFile)
		return c.body(html, 200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-cache",
		})
	})
}

/** Read a file under `root`, refusing anything that escapes it. */
async function readIfPresent(
	root: string,
	urlPath: string,
): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string } | null> {
	let decoded: string
	try {
		decoded = decodeURIComponent(urlPath)
	} catch {
		return null
	}

	const candidate = resolve(join(root, normalize(decoded)))
	// normalize() collapses `..`, but a crafted path can still escape; check the
	// resolved result rather than trusting the input shape.
	if (candidate !== root && !candidate.startsWith(`${root}/`)) return null
	if (!existsSync(candidate)) return null
	if (!statSync(candidate).isFile()) return null

	return {
		body: await readBytes(candidate),
		contentType: contentTypeFor(candidate),
	}
}

/**
 * readFile returns a Buffer, which is a Uint8Array over Node's shared pool
 * (ArrayBufferLike). Hono's `c.body` only accepts Uint8Array<ArrayBuffer>, and
 * copying also frees the pooled buffer promptly instead of pinning a whole
 * 8 KiB slab for the life of the response.
 */
async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
	const buffer = await readFile(path)
	// The element-wise constructor (not `new Uint8Array(buf.buffer, ...)`) is what
	// yields Uint8Array<ArrayBuffer>: copying element-by-element allocates a
	// fresh, non-pooled ArrayBuffer instead of aliasing Node's shared slab.
	return new Uint8Array(buffer)
}

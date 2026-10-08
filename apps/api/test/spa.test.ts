// The SPA fallback is a routing contract, not a convenience: the dashboard is
// mounted last precisely so its catch-all can only answer what nothing else
// claimed. These tests pin both halves of that — real files win, unknown paths
// become index.html for the client-side router, and nothing escapes the dist
// root. A deep link like /reviews/12 must survive a hard refresh.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { serveSpa } from "../src/presentation/http/spa.ts"

let dist: string
let app: Hono

beforeEach(() => {
	dist = mkdtempSync(join(tmpdir(), "spa-"))
	mkdirSync(join(dist, "assets"))
	writeFileSync(join(dist, "index.html"), "<!doctype html><title>PR-Agent Reviews</title>")
	writeFileSync(join(dist, "assets", "index-abc123.js"), "export const x = 1")
	writeFileSync(join(dist, "favicon.ico"), "icon")

	app = new Hono()
	// A route the SPA must NOT shadow, standing in for /api/docs and /rpc.
	app.get("/api/health", (c) => c.json({ status: "ok" }))
	serveSpa(app, dist)
})

afterEach(() => {
	rmSync(dist, { recursive: true, force: true })
})

describe("serveSpa", () => {
	test("serves index.html for the root path", async () => {
		const res = await app.request("/")
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
		expect(await res.text()).toContain("PR-Agent Reviews")
	})

	test("falls back to index.html so a deep link survives a refresh", async () => {
		const res = await app.request("/reviews/12")
		expect(res.status).toBe(200)
		expect(await res.text()).toContain("PR-Agent Reviews")
	})

	test("index.html is not cached, or a deploy would serve stale asset names", async () => {
		const res = await app.request("/")
		expect(res.headers.get("cache-control")).toBe("no-cache")
	})

	test("serves a hashed asset with the right type and an immutable cache", async () => {
		const res = await app.request("/assets/index-abc123.js")
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
		expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
		expect(await res.text()).toBe("export const x = 1")
	})

	test("serves a real file at the root of the build with no-cache", async () => {
		const res = await app.request("/favicon.ico")
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("image/x-icon")
		expect(res.headers.get("cache-control")).toBe("no-cache")
	})

	test("404s a missing asset instead of returning index.html for it", async () => {
		// Returning HTML here would be an XSS-shaped bug: a <script src> pointing
		// at a deleted asset would execute the SPA shell with the wrong MIME.
		const res = await app.request("/assets/gone.js")
		expect(res.status).toBe(404)
	})

	test("does not shadow a route registered before it", async () => {
		// This is the reason serveSpa is registered last in main.ts. If the order
		// ever flips, the catch-all would answer /api/health with index.html.
		const res = await app.request("/api/health")
		expect(res.headers.get("content-type")).toBe("application/json")
		expect(await res.json()).toEqual({ status: "ok" })
	})

	test("refuses to read outside the dist root", async () => {
		// Percent-encoded so the request line survives to the handler undecoded;
		// normalize() collapses the .. but the resolved path is what is checked.
		for (const path of [
			"/assets/%2e%2e/%2e%2e/etc/passwd",
			"/%2e%2e/%2e%2e/etc/passwd",
			"/assets/..%2f..%2fetc%2fpasswd",
		]) {
			const res = await app.request(path)
			expect(await res.text()).not.toContain("root:")
		}
	})

	test("warns once and mounts nothing when the build is missing", async () => {
		const empty = mkdtempSync(join(tmpdir(), "spa-empty-"))
		const bare = new Hono()
		const warn = console.warn
		const warnings: string[] = []
		console.warn = (msg?: unknown) => {
			warnings.push(String(msg))
		}
		try {
			serveSpa(bare, empty)
		} finally {
			console.warn = warn
		}
		rmSync(empty, { recursive: true, force: true })

		expect(warnings.join("\n")).toContain("no index.html")
		// A deployment mistake should surface as a 404, not a silent SPA 200.
		expect((await bare.request("/")).status).toBe(404)
	})
})

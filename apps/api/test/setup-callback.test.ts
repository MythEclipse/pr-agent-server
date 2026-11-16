// The GitHub App manifest callback.
//
// THE BUG THIS PINS: the conversion endpoint is `POST
// /app-manifests/{code}/conversions`, and the call was made with no method — so
// `fetch` sent a GET, GitHub answered 404/405, the `status === 201` branch never
// ran, and the callback answered `{ status: "ok" }`. Every manifest install
// therefore appeared to succeed while `credentials_callback.json` was never
// written and reviews failed later with `privateKey option is required`.

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { setupCallback } from "../src/presentation/http/setup.ts"

let appDir = ""
let calls: { url: string; init?: { method?: string; headers?: Record<string, string> } }[] = []

beforeEach(async () => {
	appDir = await mkdtemp(join(tmpdir(), "setup-callback-"))
	calls = []
})

afterEach(async () => {
	vi.unstubAllGlobals()
	await rm(appDir, { recursive: true, force: true })
})

/** Stub `fetch` and record what the callback sent. */
function stubFetch(reply: () => Promise<Response> | Response) {
	vi.stubGlobal(
		"fetch",
		async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
			calls.push({ url: String(url), init })
			return reply()
		},
	)
}

const callbackUrl = (code: string) =>
	new URL(`https://pr-agent.example/setup/callback?code=${code}`)

describe("setupCallback", () => {
	test("ignores every other path", async () => {
		stubFetch(() => Response.json({}, { status: 500 }))
		expect(await setupCallback(new URL("https://x/health"), appDir)).toBeNull()
		expect(calls).toHaveLength(0)
	})

	test("POSTs to the manifest conversion endpoint and stores the credentials", async () => {
		stubFetch(
			() =>
				new Response(
					JSON.stringify({
						id: 12345,
						pem: "-----BEGIN RSA PRIVATE KEY-----",
						webhook_secret: "whsec",
						slug: "pr-agent",
					}),
					{ status: 201, headers: { "Content-Type": "application/json" } },
				),
		)

		const res = await setupCallback(callbackUrl("one-time-code"), appDir)

		// THE METHOD IS THE FIX. Without it `fetch` defaults to GET and GitHub
		// refuses the conversion.
		expect(calls[0].init?.method).toBe("POST")
		expect(calls[0].url).toBe("https://api.github.com/app-manifests/one-time-code/conversions")
		expect(calls[0].init?.headers?.Accept).toBe("application/vnd.github+json")

		expect(res?.status).toBe(200)
		expect(await res?.json()).toEqual({
			status: "success",
			app_id: 12345,
			slug: "pr-agent",
			key_written: join(appDir, "private-key.pem"),
		})

		const written = JSON.parse(await readFile(join(appDir, "credentials_callback.json"), "utf8"))
		expect(written).toEqual({
			app_id: 12345,
			pem: "-----BEGIN RSA PRIVATE KEY-----",
			webhook_secret: "whsec",
			slug: "pr-agent",
		})

		// AND THE KEY WHERE THE PROCESS ACTUALLY READS IT.
		//
		// `credentials_callback.json` is read by nothing; `resolvePrivateKeyPem()`
		// loads `$PRIVATE_KEY_PATH` or `$appDir/private-key.pem`. Writing only the
		// callback file meant a "successful" manifest install still booted with no
		// key, and reviews died with `privateKey option is required` — the exact
		// symptom the POST fix was meant to cure.
		expect(await readFile(join(appDir, "private-key.pem"), "utf8")).toBe(
			"-----BEGIN RSA PRIVATE KEY-----",
		)
	})

	test("a 201 without a private key is an ERROR, not a success", async () => {
		// A 201 is the payload of a 201, not a promise: `JSON.stringify` drops the
		// undefined keys, so this body would have been written out as
		// `{"app_id":12345,"slug":"pr-agent"}` and reported as `success`.
		stubFetch(
			() =>
				new Response(JSON.stringify({ id: 12345, slug: "pr-agent" }), {
					status: 201,
					headers: { "Content-Type": "application/json" },
				}),
		)

		const res = await setupCallback(callbackUrl("code"), appDir)

		expect(res?.status).toBe(502)
		expect(await res?.json()).toMatchObject({ status: "error" })
		await expect(readFile(join(appDir, "credentials_callback.json"), "utf8")).rejects.toThrow()
		await expect(readFile(join(appDir, "private-key.pem"), "utf8")).rejects.toThrow()
	})

	test("a non-201 answer is an ERROR, not a cheerful ok", async () => {
		// This used to fall through to `{ status: "ok", message: "callback
		// received" }`, which told the operator the manifest flow worked while the
		// app had no credentials at all.
		stubFetch(() => new Response("Not Found", { status: 404 }))

		const res = await setupCallback(callbackUrl("expired"), appDir)

		expect(res?.status).toBe(502)
		expect(await res?.json()).toMatchObject({ status: "error" })
		// Nothing was written, and that is the point of reporting the failure.
		await expect(readFile(join(appDir, "credentials_callback.json"), "utf8")).rejects.toThrow()
	})

	test("a thrown fetch is reported, not swallowed", async () => {
		stubFetch(() => {
			throw new Error("ECONNRESET")
		})

		const res = await setupCallback(callbackUrl("code"), appDir)

		expect(res?.status).toBe(502)
		expect(await res?.json()).toMatchObject({ status: "error" })
	})

	test("a callback with no code is a 400 — the manifest flow was not completed", async () => {
		stubFetch(() => Response.json({}, { status: 201 }))

		const res = await setupCallback(new URL("https://x/setup/callback"), appDir)

		expect(res?.status).toBe(400)
		expect(calls).toHaveLength(0)
	})
})

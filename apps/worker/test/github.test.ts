// biome-ignore-all lint/suspicious/noExplicitAny: test fakes stand in for untyped GitHub payloads
// biome-ignore-all lint/style/noNonNullAssertion: test asserts immediately after each non-null use
import { createVerify, generateKeyPairSync } from "node:crypto"
import { createServer, type Server, type Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { GitHubApi, type Spawner } from "../src/github.ts"
import { startHttpStub } from "./helpers/http-stub.ts"

// ── Fixtures ────────────────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString()
const APP_ID = "4319749"

/** One recorded inbound request, as the fake GitHub saw it. */
type Seen = { method: string; url: string; headers: Record<string, string>; body: string }

/**
 * Fake GitHub on an ephemeral port. `handler` decides the response per call and
 * the server records what it received, so the tests assert on the wire rather
 * than on internals.
 */
async function fakeGitHub(
	handler: (call: number, req: Request) => Response | Promise<Response>,
): Promise<{ baseUrl: string; seen: Seen[]; stop: () => void }> {
	const seen: Seen[] = []
	const server = await startHttpStub(async (req) => {
		seen.push({
			method: req.method,
			url: new URL(req.url).pathname,
			headers: Object.fromEntries(req.headers),
			body: await req.text(),
		})
		return handler(seen.length, req)
	})
	return {
		baseUrl: server.url,
		seen,
		stop: () => void server.close(),
	}
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})

// A tight transport timeout so a starved CPU cannot turn a real round trip
// into the `{status: 0}` failure sentinel. These tests assert on the retry and
// error paths, and the production 30s budget made the whole 16-file suite
// load-sensitive: this file alone was observed failing at ~1-in-6 under 12
// busy-loop processes on 8 cores. Every request here is to a loopback stub, so
// anything above a second can only be scheduling starvation, never a real wait.
const TEST_TIMEOUT_MS = 5_000

const api = (baseUrl: string, spawn?: Spawner) =>
	new GitHubApi({
		appId: APP_ID,
		privateKeyPem: PRIVATE_KEY_PEM,
		baseUrl,
		spawn,
		timeoutMs: TEST_TIMEOUT_MS,
	})

const b64json = (segment: string) =>
	JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>

// ── 1. jwt() ───────────────────────────────────────────────────────────────

describe("GitHubApi.jwt", () => {
	// Python lines 158-161: iat = now-60, exp = now+600, iss = APP_ID, RS256.
	test("emits a three-segment RS256 token with the Python claims", () => {
		const token = api("http://unused.invalid").jwt()
		const parts = token.split(".")
		expect(parts).toHaveLength(3)
		expect(b64json(parts[0])).toEqual({ alg: "RS256", typ: "JWT" })
		const payload = b64json(parts[1])
		expect(payload.iss).toBe(APP_ID)
		// 660s lifetime: the 60s backdate absorbs clock skew on the GitHub side.
		expect(Number(payload.exp) - Number(payload.iat)).toBe(660)
	})

	// A token that merely *looks* like a JWT is worthless; only a real RSA
	// signature over the exact header.payload bytes makes GitHub accept it.
	test("signs header.payload with a verifiable RS256 signature", () => {
		const [head, body, sig] = api("http://unused.invalid").jwt().split(".")
		const valid = createVerify("RSA-SHA256")
			.update(`${head}.${body}`)
			.verify(PUBLIC_KEY_PEM, Buffer.from(sig!, "base64url"))
		expect(valid).toBe(true)
	})
})

// ── 2. request(): headers ───────────────────────────────────────────────────

describe("GitHubApi.request headers", () => {
	let gh: Awaited<ReturnType<typeof fakeGitHub>>
	beforeEach(async () => {
		gh = await fakeGitHub(() => json({ ok: true }))
	})
	afterEach(() => gh.stop())

	test("authenticates with Bearer <jwt> when no token is supplied", async () => {
		const a = api(gh.baseUrl)
		const { status, data } = await a.request("GET", "/user")
		expect(status).toBe(200)
		expect(data).toEqual({ ok: true })
		const auth = gh.seen[0].headers.authorization
		expect(auth.startsWith("Bearer ")).toBe(true)
		expect(b64json(auth.slice("Bearer ".length).split(".")[1]!).iss).toBe(APP_ID)
	})

	// Ruling 2: the scheme is conditional, exactly as Python line 166. An
	// installation token is sent as "token <t>" — GitHub rejects a Bearer
	// installation token outright.
	test("authenticates with token <token> when one is supplied", async () => {
		await api(gh.baseUrl).request("GET", "/installation/repositories", { token: "ghs_faketoken" })
		expect(gh.seen[0].headers.authorization).toBe("token ghs_faketoken")
	})

	// Ruling 3: the worker never sends this header; adding one would be a silent
	// behaviour change against the live Python. (`host`, `connection`,
	// `user-agent` and `accept-encoding` are added by the transport below our
	// control, so the assertion is on the headers this client owns.)
	test("sets no x-github-api-version and uses the v3 Accept", async () => {
		await api(gh.baseUrl).request("GET", "/user")
		const h = gh.seen[0].headers
		expect(h["x-github-api-version"]).toBeUndefined()
		expect(h.accept).toBe("application/vnd.github.v3+json")
		expect(h.authorization).toMatch(/^Bearer /)
	})

	test("forwards method, path and the JSON body", async () => {
		await api(gh.baseUrl).request("POST", "/repos/o/r/pulls/7/reviews", {
			token: "ghs_x",
			json: { event: "APPROVE" },
		})
		expect(gh.seen[0].method).toBe("POST")
		expect(gh.seen[0].url).toBe("/repos/o/r/pulls/7/reviews")
		expect(JSON.parse(gh.seen[0].body)).toEqual({ event: "APPROVE" })
	})
})

// ── 3. request(): 5xx is NOT retried (ruling 1) ─────────────────────────────

describe("GitHubApi.request status handling", () => {
	let gh: Awaited<ReturnType<typeof fakeGitHub>>
	afterEach(() => gh.stop())

	// Python gh_api only retries TRANSPORT errors. A 500 is a completed round trip
	// and is handed straight back to the caller, which decides what to do with it.
	test("returns a 500 to the caller after exactly one call", async () => {
		gh = await fakeGitHub(() => json({ message: "boom" }, 500))
		const { status, data } = await api(gh.baseUrl).request("GET", "/user")
		expect(status).toBe(500)
		expect(data).toEqual({ message: "boom" })
		expect(gh.seen).toHaveLength(1)
	})

	// Python line 174: a body that will not parse becomes `{}` — not an error.
	test("returns an empty object for a non-JSON body and does not retry", async () => {
		gh = await fakeGitHub(() => new Response("<html>nope</html>", { status: 418 }))
		const { status, data } = await api(gh.baseUrl).request("GET", "/user")
		expect(status).toBe(418)
		expect(data).toEqual({})
		expect(gh.seen).toHaveLength(1)
	})

	test("applies a 30s timeout signal to every attempt", async () => {
		gh = await fakeGitHub(() => json({ ok: true }))
		const realFetch = globalThis.fetch
		const signals: (AbortSignal | null | undefined)[] = []
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			signals.push(init?.signal)
			return realFetch(input, init)
		}) as typeof fetch
		try {
			await api(gh.baseUrl).request("GET", "/user")
		} finally {
			globalThis.fetch = realFetch
		}
		// Bun's fetch has NO default timeout, so an explicit signal is load-bearing:
		// without it a hung GitHub connection would wedge the cron tick forever.
		expect(signals).toHaveLength(1)
		expect(signals[0]).toBeInstanceOf(AbortSignal)
	})
})

// ── 4. request(): transport-error retry (ruling 1) ──────────────────────────

describe("GitHubApi.request transport retries", () => {
	let drop: Server
	let accepts = 0
	let baseUrl = ""
	/** When true every connection is dropped, so the attempt count is observable. */
	let dropAll = false

	// A real TCP-level drop, not a stubbed fetch: the first connection is accepted
	// and then destroyed with no response, which is what fetch surfaces as
	// ECONNRESET (httpx's RemoteProtocolError/ReadError in the Python).
	beforeEach(async () => {
		accepts = 0
		dropAll = false
		drop = createServer((sock: Socket) => {
			accepts++
			if (dropAll || accepts === 1) {
				sock.once("data", () => sock.destroy())
				return
			}
			let buf = ""
			sock.on("data", (chunk) => {
				buf += chunk.toString()
				if (!buf.includes("\r\n\r\n")) return
				const body = '{"ok":true}'
				sock.end(
					`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
				)
			})
		})
		await new Promise<void>((r) => drop.listen(0, "127.0.0.1", () => r()))
		baseUrl = `http://127.0.0.1:${(drop.address() as { port: number }).port}`
	})
	afterEach(() => drop.close())

	// The backoff is REAL (2**attempt seconds = 1s on the first retry), so this
	// test genuinely waits ~1s rather than mocking the sleep away.
	test("retries after a dropped connection and returns the next attempt's 200", async () => {
		const { status, data } = await api(baseUrl).request("GET", "/user", { retries: 2 })
		expect(status).toBe(200)
		expect(data).toEqual({ ok: true })
		expect(accepts).toBe(2)
	}, 15_000)

	// Python line 168 is `for attempt in range(retries)`: `retries` is the TOTAL
	// number of attempts, not the number of retries after the first. An
	// off-by-one here would sleep 4s and hammer GitHub 50% more than intended.
	test("attempts exactly `retries` times, sleeping 2**attempt seconds", async () => {
		dropAll = true
		const started = Date.now()
		const { status } = await api(baseUrl).request("GET", "/user", { retries: 3 })
		expect(status).toBe(0)
		expect(accepts).toBe(3)
		// Two sleeps: 2**0 = 1s and 2**1 = 2s. Asserted as a lower bound so a slow
		// CI box does not produce a flake.
		expect(Date.now() - started).toBeGreaterThanOrEqual(3000)
	}, 20_000)

	// Python lines 192-193: after the loop it logs and returns (0, {}). Callers
	// treat 0 as failure, and gh_api itself never raises.
	test("returns status 0 with empty data once retries are exhausted", async () => {
		// Nothing is listening on this port: every attempt is a connection refusal.
		const closed = new GitHubApi({
			appId: APP_ID,
			privateKeyPem: PRIVATE_KEY_PEM,
			baseUrl: "http://127.0.0.1:1",
		})
		const { status, data } = await closed.request("GET", "/user", { retries: 2 })
		expect(status).toBe(0)
		expect(data).toEqual({})
	}, 15_000)

	// PARITY GAP FOUND BY THE CONTROLLER: a body that stops mid-stream.
	// httpx raises RemoteProtocolError here, so Python RETRIES. Bun's fetch
	// resolves the Response with a real 200 and only rejects when the body is
	// read — so the inner catch turns a truncated response into
	// `{status: 200, data: {}}`, i.e. a caller sees SUCCESS carrying no data.
	// Verified against a real socket: fetch resolved 200, .text() rejected.
	test("a body truncated mid-stream must not read as a successful empty 200", async () => {
		let calls = 0
		const trunc = createServer((sock: Socket) => {
			calls++
			sock.once("data", () => {
				if (calls === 1) {
					// Headers promise 999 bytes; send 10, then kill the socket.
					sock.write(
						'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{"partial":',
					)
					setTimeout(() => sock.destroy(), 10)
					return
				}
				const body = '{"ok":true}'
				sock.end(
					`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
				)
			})
		})
		await new Promise<void>((r) => trunc.listen(0, "127.0.0.1", () => r()))
		const url = `http://127.0.0.1:${(trunc.address() as { port: number }).port}`
		try {
			const res = await api(url).request("GET", "/user", { retries: 2 })
			// httpx raises RemoteProtocolError on a truncated body, so the Python
			// retries and the SECOND attempt's complete response is what the caller
			// sees. The bug this pins is the OLD behaviour: attempt 1 resolved as a
			// real 200 and was returned immediately with data {}, so calls === 1 and
			// the truncated payload was never re-requested.
			expect(res.status).toBe(200)
			expect(res.data).toEqual({ ok: true })
			expect(calls).toBe(2)
		} finally {
			trunc.close()
		}
	}, 15_000)
})

// ── 5. installationToken ───────────────────────────────────────────────────

describe("GitHubApi.installationToken", () => {
	let gh: Awaited<ReturnType<typeof fakeGitHub>>
	afterEach(() => gh.stop())

	test("POSTs to the access_tokens endpoint and returns the token", async () => {
		gh = await fakeGitHub(() => json({ token: "ghs_install", expires_at: "2026-01-01T00:00:00Z" }))
		const token = await api(gh.baseUrl).installationToken(4242)
		expect(token).toBe("ghs_install")
		expect(gh.seen[0].method).toBe("POST")
		expect(gh.seen[0].url).toBe("/app/installations/4242/access_tokens")
		// Python line 196 calls gh_api WITHOUT a token, so this is a JWT call.
		expect(gh.seen[0].headers.authorization.startsWith("Bearer ")).toBe(true)
	})

	// Python line 197 `data.get("token", "")` on the `{}` that an exhausted retry
	// returns — a failed lookup degrades to an empty token, it does not throw.
	test("returns an empty string when the lookup fails", async () => {
		gh = await fakeGitHub(() => json({ message: "Not Found" }, 404))
		expect(await api(gh.baseUrl).installationToken(1)).toBe("")
	})
})

// ── 6. fetchGhToken ─────────────────────────────────────────────────────────

describe("GitHubApi.fetchGhToken", () => {
	const argvOf = (calls: string[][]) => calls

	test("runs gh auth token, trims stdout and caches it for the process", () => {
		const calls: string[][] = []
		const spawn: Spawner = (argv) => {
			calls.push(argv)
			return { exitCode: 0, stdout: "  ghp_realtoken \n" }
		}
		const a = api("http://unused.invalid", spawn)
		expect(a.fetchGhToken()).toBe("ghp_realtoken")
		expect(a.fetchGhToken()).toBe("ghp_realtoken")
		// One spawn for the whole process, not one per call site as in the Python.
		expect(argvOf(calls)).toEqual([["gh", "auth", "token"]])
	})

	test("returns an empty string on a non-zero exit", () => {
		const a = api("http://unused.invalid", () => ({ exitCode: 1, stdout: "ghp_leaked\n" }))
		expect(a.fetchGhToken()).toBe("")
	})

	// Python lines 605-606: a missing/broken gh CLI must not crash the tick.
	test("returns an empty string when the spawn throws", () => {
		const a = api("http://unused.invalid", () => {
			throw new Error("ENOENT")
		})
		expect(a.fetchGhToken()).toBe("")
	})
})

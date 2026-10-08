// Test-only HTTP stub standing in for Bun.serve.
//
// The worker tests bind a loopback server so the real fetch path runs against
// it. Bun.serve is gone in P2, so this starts a node:http server on port 0 and
// hands back the URL plus the request log the assertions inspect.
//
// The handler keeps Bun's `(req: Request) => Response` signature so the test
// bodies port over unchanged — node:http is adapted to it below.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

export interface StubRequest {
	method: string
	url: string
	/** Request body as text, or "" when there was none. */
	body: string
	headers: Record<string, string | string[] | undefined>
}

export interface HttpStub {
	/** Base URL with no trailing slash, e.g. "http://127.0.0.1:52341". */
	url: string
	/** Every request the stub received, in arrival order. */
	requests: StubRequest[]
	close(): Promise<void>
}

/**
 * Start a loopback HTTP stub. `handler` receives a web-standard Request and
 * returns a web-standard Response, matching the Bun.serve shape the tests were
 * written against.
 */
export async function startHttpStub(
	handler: (req: Request) => Response | Promise<Response>,
): Promise<HttpStub> {
	const requests: StubRequest[] = []

	const server = createServer((incoming: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = []
		incoming.on("data", (c: Buffer) => chunks.push(c))
		incoming.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8")
			requests.push({
				method: incoming.method ?? "GET",
				url: incoming.url ?? "/",
				body,
				headers: incoming.headers,
			})

			const method = incoming.method ?? "GET"
			const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
				method,
				headers: incoming.headers as Record<string, string>,
				body: method === "GET" || method === "HEAD" ? undefined : body,
			})

			void (async () => {
				try {
					const response = await handler(request)
					const payload = Buffer.from(await response.arrayBuffer())
					const headers: Record<string, string | number> = {}
					// A 204 must not carry a body or a content-length; Node's
					// writeHead rejects a mismatched pair, so let writeHead own
					// the framing and pass through only content headers.
					for (const [k, v] of response.headers.entries()) {
						if (k === "content-length") continue
						headers[k] = v
					}
					if (response.status !== 204 && response.status !== 304) {
						headers["content-length"] = payload.byteLength
					}
					res.writeHead(response.status, headers)
					res.end(response.status === 204 || response.status === 304 ? undefined : payload)
				} catch (err) {
					res.writeHead(500, { "content-type": "text/plain" })
					res.end(String(err))
				}
			})()
		})
	})

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve)
	})
	const { port } = server.address() as AddressInfo

	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve())
			}),
	}
}

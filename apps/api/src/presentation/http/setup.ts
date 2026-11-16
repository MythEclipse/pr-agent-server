// GitHub App manifest setup callback (/setup/callback): exchange the one-time
// code for app credentials and persist them next to the private key.
//
// THE CONVERSION ENDPOINT IS A POST. GitHub documents
// `POST /app-manifests/{code}/conversions`; called without a method the request
// went out as a GET, which GitHub answers with 404/405 — so the branch below
// never ran, the credentials were never written, and every manifest install
// silently ended at the `{ status: "ok" }` fallback while the app had no key.
// Measured: the callback returned 200 and `credentials_callback.json` was
// absent, so reviews failed later with `privateKey option is required`.

import { writeFile } from "node:fs/promises"

/** GitHub's current API version, so a future default cannot change the reply. */
const GITHUB_API_VERSION = "2022-11-28"

export async function setupCallback(url: URL, appDir: string): Promise<Response | null> {
	if (url.pathname !== "/setup/callback") return null
	const code = url.searchParams.get("code") || ""
	if (!code) {
		// No code means the manifest flow was not completed (or the URL was
		// visited directly). Saying "ok" here is what made the failure
		// indistinguishable from a success.
		return Response.json(
			{
				status: "error",
				message: "missing code — open this URL from the GitHub App manifest flow",
			},
			{ status: 400 },
		)
	}

	try {
		const resp = await fetch(
			`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
			{
				// The method GitHub requires. Without it `fetch` defaults to GET.
				method: "POST",
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": GITHUB_API_VERSION,
				},
			},
		)
		if (resp.status === 201) {
			const data = (await resp.json()) as {
				id?: number
				pem?: string
				webhook_secret?: string
				slug?: string
			}
			// A 201 IS NOT YET A CREDENTIAL. The body is the payload of a 201, not
			// a promise: `{id, slug}` with no `pem` would have been written out as
			// `{"app_id":12345,"slug":"pr-agent"}` — `JSON.stringify` drops the
			// undefined keys silently — and reported `status: "success"`. That is
			// the same lie this callback exists to stop telling, one payload-shape
			// away. No key, no success.
			if (typeof data.pem !== "string" || data.pem.length === 0 || typeof data.id !== "number") {
				console.error("[callback] manifest conversion returned no usable credentials")
				return Response.json(
					{
						status: "error",
						message: "manifest conversion returned no private key — the app has no credentials",
					},
					{ status: 502 },
				)
			}
			const creds = {
				app_id: data.id,
				pem: data.pem,
				webhook_secret: data.webhook_secret,
				slug: data.slug,
			}
			await writeFile(`${appDir}/credentials_callback.json`, JSON.stringify(creds, null, 2), "utf8")
			// AND THE KEY WHERE THE PROCESS ACTUALLY LOOKS FOR IT.
			//
			// Nothing in this repository ever read `credentials_callback.json`;
			// `resolvePrivateKeyPem()` loads `$PRIVATE_KEY_PATH` or
			// `$appDir/private-key.pem`. So a manifest install that wrote only the
			// callback file left the process booting with no key at all, and the
			// reviews failed with `[@octokit/auth-app] privateKey option is
			// required` — the exact symptom the POST fix was supposed to cure.
			// Mode 0600: a private key must not be world-readable.
			await writeFile(`${appDir}/private-key.pem`, data.pem, { encoding: "utf8", mode: 0o600 })
			return Response.json({
				status: "success",
				app_id: creds.app_id,
				slug: creds.slug,
				key_written: `${appDir}/private-key.pem`,
			})
		}
		// A NON-201 IS A FAILURE, and it is reported as one. This used to fall
		// through to `{ status: "ok" }`, which told the operator the manifest
		// flow had worked while the app had no credentials at all.
		console.error(`[callback] manifest conversion failed: HTTP ${resp.status}`)
		return Response.json(
			{ status: "error", message: `manifest conversion failed (HTTP ${resp.status})` },
			{ status: 502 },
		)
	} catch (e) {
		console.error("[callback] conversion failed:", e)
		return Response.json(
			{ status: "error", message: `manifest conversion failed: ${String(e)}` },
			{ status: 502 },
		)
	}
}

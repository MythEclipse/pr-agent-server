// GitHub App manifest setup callback (/setup/callback): exchange the one-time
// code for app credentials and persist them next to the private key.

import { writeFile } from "node:fs/promises"

export async function setupCallback(url: URL, appDir: string): Promise<Response | null> {
	if (url.pathname !== "/setup/callback") return null
	const code = url.searchParams.get("code") || ""
	if (code) {
		try {
			const resp = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
				headers: { Accept: "application/vnd.github.v3+json" },
			})
			if (resp.status === 201) {
				const data = (await resp.json()) as {
					id?: number
					pem?: string
					webhook_secret?: string
					slug?: string
				}
				const creds = {
					app_id: data.id,
					pem: data.pem,
					webhook_secret: data.webhook_secret,
					slug: data.slug,
				}
				await writeFile(
					`${appDir}/credentials_callback.json`,
					JSON.stringify(creds, null, 2),
					"utf8",
				)
				return Response.json({
					status: "success",
					app_id: creds.app_id,
					slug: creds.slug,
				})
			}
		} catch (e) {
			console.error("[callback] conversion failed:", e)
		}
	}
	return Response.json({ status: "ok", message: "callback received" })
}

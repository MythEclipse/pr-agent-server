// GitHub webhook endpoint: verify the HMAC signature, filter to actionable
// pull_request events, then hand a review job to the queue. Answers GitHub
// immediately (well under the 10s webhook budget); the queue worker owns the
// review itself and the notifications that follow it.

import { createHmac, timingSafeEqual } from "node:crypto"
import type { Config } from "../../infrastructure/config/legacy-config.ts"
import type { ReviewQueue } from "../queue/review-queue.ts"

export type { ReviewJob } from "../queue/review-queue.ts"

export interface WebhookEnv {
	cfg: Config
	privateKeyPem: string
	webhookSecret: string
	analyticsDir: string
	discordWebhookUrl: string
	discordAlertWebhookUrl: string
}

export async function handleWebhook(
	env: WebhookEnv,
	body: string,
	signatureHeader: string | null,
	event: string,
	queue: ReviewQueue,
): Promise<{ status: number; body: unknown }> {
	// HMAC verification (sha256)
	if (!signatureHeader) {
		return { status: 403, body: { error: "missing signature" } }
	}
	const sig = signatureHeader.replace(/^sha256=/i, "")
	const expected = createHmac("sha256", env.webhookSecret).update(body).digest("hex")
	const a = Buffer.from(sig, "hex")
	const b = Buffer.from(expected, "hex")
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return { status: 403, body: { error: "invalid signature" } }
	}

	if (event !== "pull_request") {
		return { status: 200, body: { ok: true, ignored: true } }
	}

	let payload: {
		action?: string
		pull_request?: {
			number?: number
			state?: string
			url?: string
			draft?: boolean
			labels?: { name?: string }[]
		}
		installation?: { id?: number }
	}
	try {
		payload = JSON.parse(body)
	} catch {
		return { status: 400, body: { error: "invalid JSON" } }
	}

	const pr = payload.pull_request
	if (!pr || !pr.number || pr.state !== "open" || pr.draft) {
		return { status: 200, body: { ok: true, ignored: true } }
	}

	// extract owner/repo from the pull_request.url (api.github.com/repos/{o}/{r}/pulls/{n})
	let owner = ""
	let repo = ""
	if (pr.url) {
		const m = /\/repos\/([^/]+)\/([^/]+)\/pulls\//.exec(pr.url)
		if (m) {
			owner = m[1]
			repo = m[2]
		}
	}
	if (!owner || !repo) {
		return { status: 200, body: { ok: true, ignored: true, error: "no repo" } }
	}

	// Fire and forget: the queue runs the review in the background.
	queue.enqueue({ owner, repo, pr: pr.number })
	return { status: 200, body: { ok: true, triggered: true } }
}

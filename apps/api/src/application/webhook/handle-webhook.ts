// GitHub webhook endpoint: verify the HMAC signature, filter to actionable
// pull_request events, then hand a review job to the queue. Answers GitHub
// immediately (well under the 10s webhook budget); the queue worker owns the
// review itself and the notifications that follow it.

import { createHmac, timingSafeEqual } from "node:crypto"
import type { Config } from "../../infrastructure/config/legacy-config.ts"

export type { ReviewJob } from "../queue/review-queue.ts"

/**
 * The only thing this handler needs from a queue: somewhere to put a job.
 *
 * Declared as a PORT rather than narrowed to the in-memory `ReviewQueue` class,
 * because both backends satisfy it and only one of them is asynchronous — which
 * is exactly what the caller must know to await it. Typing it as the class made
 * the Postgres backend's promise invisible here, and that is how it went
 * unhandled.
 */
export interface IReviewQueuePort {
	enqueue(job: {
		owner: string
		repo: string
		pr: number
	}): "queued" | "deduped" | Promise<"queued" | "deduped">
}

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
	queue: IReviewQueuePort,
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
	if (!pr?.number || pr.state !== "open" || pr.draft) {
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

	// Enqueue, and SURVIVE a store failure. This used to be fire-and-forget:
	// `queue.enqueue(...)` returned a promise nobody awaited, so a Postgres error
	// became an unhandled rejection — fatal on Node 24 — while the handler had
	// already answered `{triggered: true}`. Probed against a rejecting queue: the
	// 200 went out and then the process died.
	//
	// Answering 5xx is the point, not a nicety: GitHub redelivers a failed webhook
	// delivery, so a store outage delays the review instead of erasing it. A 200
	// here would tell GitHub the event was handled and nothing would ever retry it.
	// The insert is a single round-trip, well inside the 10s webhook budget.
	try {
		await queue.enqueue({ owner, repo, pr: pr.number })
	} catch (err) {
		console.error(`[webhook] enqueue failed for ${owner}/${repo}#${pr.number}:`, err)
		return { status: 500, body: { error: "enqueue failed" } }
	}
	return { status: 200, body: { ok: true, triggered: true } }
}

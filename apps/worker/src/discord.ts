/**
 * Ops notifier — port of `scripts/pr-queue-worker.py` lines 1036-1052
 * (`post_sync_discord`) and lines 472-483 (`post_discord_notification`).
 *
 * Both are best-effort: a cron tick must not die because Discord is down, the
 * webhook config is missing, or the local server is not running.
 *
 * WHY THIS IS A SEPARATE MODULE from `report.ts` rather than a reuse of its
 * helper: `Report.flush` (py:130-155) owns a DIFFERENT contract — it decides
 * between stdout (TTY) and Discord, clears its own buffer, and returns void
 * regardless of delivery. `postDiscordOps` (py:1036) always posts a
 * caller-supplied embed and must return whether the status was 200/204, because
 * the sync reporter branches on it. Neither module owns the other. The one
 * thing that IS shared — the call-time webhook lookup, previously copied
 * verbatim between the two files — now lives in `ops-webhook.ts`, so the
 * precedence rule and the production fallback are stated exactly once.
 */
import { opsWebhookUrl } from "./ops-webhook.ts"

/** Python `post_discord_notification`'s default (line 475). */
export const PR_AGENT_NOTIFY_URL = "http://127.0.0.1:4023/api/v1/notify_review"
/** Python `httpx.Client(timeout=15)` for the webhook, `(timeout=5)` for notify. */
const WEBHOOK_TIMEOUT_MS = 15_000
const NOTIFY_TIMEOUT_MS = 5_000
/** Python `"\n".join(lines)[:4000]` (line 1048) — Discord's embed limit. */
const MAX_DESCRIPTION = 4000
/** Python `summary[:500]` (line 480). */
const MAX_SUMMARY = 500
/** Python's default `color=0x5865F2` (line 1036) — Discord blurple. */
const DEFAULT_COLOR = 0x5865f2

/**
 * Python `post_sync_discord(title, lines, color=0x5865F2)` (lines 1036-1052).
 * Resolves true only for a 200/204, false for anything else.
 */
export async function postDiscordOps(
	title: string,
	lines: string[],
	color: number = DEFAULT_COLOR,
): Promise<boolean> {
	const url = opsWebhookUrl()
	if (!url) return false // Python lines 1042-1043
	try {
		const r = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				username: "PR-Agent Ops",
				embeds: [{ title, description: lines.join("\n").slice(0, MAX_DESCRIPTION), color }],
			}),
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		})
		return r.status === 200 || r.status === 204 // Python line 1050
	} catch {
		return false
	}
}

/**
 * Python `post_discord_notification(repo_full, pr_num, status, summary, score, url)`
 * (lines 472-483). Fire-and-forget: the status is ignored and every failure is
 * swallowed, because the caller is a notification side effect, not a gate.
 */
export async function notifyReview(
	repo: string,
	pr: number,
	status: string,
	summary: string,
	score: string | number,
	url: string,
): Promise<void> {
	const notifyUrl = process.env.PR_AGENT_NOTIFY_URL || PR_AGENT_NOTIFY_URL
	try {
		await fetch(notifyUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				repo,
				pr,
				status,
				// Python slices BEFORE stringifying the score (`str(score)`), so a
				// number score still arrives as a string on the wire.
				summary: String(summary).slice(0, MAX_SUMMARY),
				score: String(score),
				url,
			}),
			signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
		})
	} catch {
		/* never raises, never blocks a tick */
	}
}

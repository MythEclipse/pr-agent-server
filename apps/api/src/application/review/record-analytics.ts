// Analytics records for a finished review.
//
// WHY THIS FILE EXISTS: `notify-review.ts` used to write these two records, but
// nothing ever imported it — the webhook went straight from `handleWebhook` to
// the queue, so `/api/metrics` and `/api/analytics` read a directory that only
// the CLI ever wrote to. On the server that meant `pr_agent_requests_total`
// stayed at 0 while reviews ran, and the README documented a Prometheus counter
// that could not move. The file was deleted as dead code; the WRITE was what was
// actually missing, so it is restored here as an explicit seam on `runJob`.
//
// Two records are written, deliberately, because two readers exist:
//   - `appendAnalyticsEvent` → `pr-agent.<pid>.log`, which is what
//     `generateMetrics` and `/api/analytics` parse (legacy Python shape).
//   - `appendBunAnalyticsRecord` → `pr-agent.bun.jsonl`, the raw per-review feed.
//
// Neither import of the Discord webhook is here. Notifying a channel is a
// separate side-effect with its own failure modes, and reviving it silently
// alongside the metrics fix would have made a "metrics are zero" fix quietly
// start posting to Discord too.

import {
	appendAnalyticsEvent,
	appendBunAnalyticsRecord,
} from "../../infrastructure/analytics/jsonl.ts"

/** What a finished review reports about itself. `model` is the SERVED model. */
export type ReviewAnalyticsOutcome =
	| {
			status: "success"
			model: string
			promptTokens: number
			completionTokens: number
			cachedTokens: number
			markdownLength: number
	  }
	| { status: "failed"; error: string }

export type ReviewAnalyticsTarget = { owner: string; repo: string; pr: number }

export type RecordAnalyticsDeps = {
	analyticsDir: string
}

/**
 * Write both analytics records for one finished review.
 *
 * NEVER THROWS. `runJob` calls this after `history.finish`, and on the failure
 * arm it is reached before the original error is rethrown — an analytics write
 * that rejected would replace a review error with a bookkeeping one, which is
 * exactly the class of bug this repo keeps fixing. The appenders already
 * swallow their own I/O errors; the catch here covers everything else.
 */
export async function recordReviewAnalytics(
	deps: RecordAnalyticsDeps,
	target: ReviewAnalyticsTarget,
	outcome: ReviewAnalyticsOutcome,
): Promise<void> {
	if (!deps.analyticsDir) return
	const { owner, repo, pr } = target

	try {
		if (outcome.status === "failed") {
			// The message text matters: `generateMetrics` classifies a failure by
			// `msg.includes("Failed to generate")`, and `/api/analytics` filters
			// `failures` on the same prefix. Changing this string silently turns
			// every failed review into a success in the counter.
			await appendAnalyticsEvent(deps.analyticsDir, {
				message: `Failed to generate ${outcome.error}`,
				extra: {
					command: "review",
					pr_url: `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}`,
					pr_url_short: `${owner}/${repo}#${pr}`,
					model: "",
					error: outcome.error,
				},
			})
			// No JSONL row: that feed is typed for a completed review (it carries
			// token counts), and inventing zeros would make a failure look like a
			// review that ran and produced nothing.
			return
		}

		await appendAnalyticsEvent(deps.analyticsDir, {
			message: "Generated code suggestions",
			extra: {
				command: "review",
				pr_url: `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}`,
				model: outcome.model,
				model_request: outcome.model,
				pr_url_short: `${owner}/${repo}#${pr}`,
				error: "",
			},
		})

		await appendBunAnalyticsRecord(deps.analyticsDir, {
			time: new Date().toISOString(),
			repo: `${owner}/${repo}`,
			pr,
			command: "review",
			model: outcome.model,
			prompt_tokens: outcome.promptTokens,
			completion_tokens: outcome.completionTokens,
			cached_tokens: outcome.cachedTokens,
			markdown_len: outcome.markdownLength,
		})
	} catch (err) {
		// Swallowed on purpose — see NEVER THROWS above.
		console.error(`[analytics] could not record review for ${owner}/${repo}#${pr}: ${String(err)}`)
	}
}

// Notification side-effects of a finished review: the success and failure paths
// that used to be inline in handleWebhook's .then()/.catch(). Log strings,
// analytics record shapes and Discord copy are preserved verbatim.

import { appendAnalyticsEvent, appendBunAnalyticsRecord } from "../analytics";
import { htmlToDiscordPlain, sendDiscord } from "../notify/discord";
import type { ReviewResult } from "../review";
import type { ReviewJob, WebhookEnv } from "./webhook";

type NotifyEnv = Pick<WebhookEnv, "analyticsDir" | "discordWebhookUrl" | "discordAlertWebhookUrl">;

export async function notifyReviewSuccess(env: NotifyEnv, job: ReviewJob, result: ReviewResult): Promise<void> {
  const { owner, repo, pr } = job;
  console.log(`[webhook] review done for ${owner}/${repo}#${pr}: ${result.status}, model ${result.model}, md ${result.markdown.length} chars`);

  // legacy pr-agent.*.log event (read back by /api/metrics + /api/analytics)
  await appendAnalyticsEvent(env.analyticsDir, {
    message: result.status === "success" ? "Generated code suggestions" : `Failed to generate ${result.status}`,
    extra: {
      command: "review",
      pr_url: `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}`,
      model: result.model,
      model_request: result.model,
      pr_url_short: `${owner}/${repo}#${pr}`,
      error: result.status === "success" ? "" : result.status,
    },
  });

  // raw Bun-side feed (pr-agent.bun.jsonl)
  await appendBunAnalyticsRecord(env.analyticsDir, {
    time: new Date().toISOString(),
    repo: `${owner}/${repo}`,
    pr,
    command: "review",
    model: result.model,
    prompt_tokens: result.promptTokens,
    completion_tokens: result.completionTokens,
    cached_tokens: result.cachedTokens,
    markdown_len: result.markdown.length,
  });

  if (result.markdown && env.discordWebhookUrl) {
    await sendDiscord(
      env.discordWebhookUrl,
      `**${owner}/${repo}** PR #${pr} reviewed` +
        (result.data && result.data["review"] && (result.data["review"] as Record<string, unknown>)["score"]
          ? ` — score ${(result.data["review"] as Record<string, unknown>)["score"]}/100`
          : "") +
        `\n${htmlToDiscordPlain(result.markdown).slice(0, 4000)}`,
      "✅ PR-Agent Review Complete",
    );
  }
}

export async function notifyReviewFailure(env: NotifyEnv, job: ReviewJob, e: unknown): Promise<void> {
  const { owner, repo, pr } = job;
  console.error(`[webhook] review FAILED for ${owner}/${repo}#${pr}:`, e instanceof Error ? e.stack ?? e.message : e);
  if (env.discordAlertWebhookUrl) {
    await sendDiscord(
      env.discordAlertWebhookUrl,
      `**${owner}/${repo}** PR #${pr} review FAILED\n\`\`\`${String((e as Error).message)}\`\`\``,
      "🚨 PR-Agent Review Failed",
    );
  }
}

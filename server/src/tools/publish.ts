// Shared publish-side helpers for the review/describe/improve tools.

import type { GitHubProvider } from "../github";

/** Publish the tool output as a persistent comment: find the previous comment
 *  starting with `header` and update it in place (pr_agent behavior), else
 *  create a new one. Used by review, describe and improve. */
export async function publishPersistent(
  provider: GitHubProvider,
  markdown: string,
  header: string,
  name: string,
  finalUpdateMessage: boolean,
): Promise<void> {
  await provider.publishPersistentComment(markdown, header, name, finalUpdateMessage);
}
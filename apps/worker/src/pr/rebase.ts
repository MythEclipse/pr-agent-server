/**
 * The Dependabot rebase request — the deterministic answer to a conflicted
 * dependency bump.
 *
 * THE BUG THIS EXISTS FOR. A Dependabot PR conflicts with its base branch when
 * the base moved under the bump, and the pipeline's answer was to hand the
 * conflict to Claude Code. That agent edits SOURCE files; it cannot regenerate a
 * `package-lock.json` or a `requirements.txt` pin graph, so on a dependency bump
 * it reliably makes no push. `resolveConflict` then recorded
 * `Unresolvable merge conflict (Claude Code made no push)` as a `skip_reason`,
 * which is enforced "until head SHA changes" — and nothing about a failed agent
 * run moves the head. The PR was pinned permanently.
 *
 * Measured on MythEclipse/ML-Tapi-Bukan-Mobile-Legends#4 and #5 (2026-11-12),
 * both pillow bumps whose `requirements.txt` had already been regenerated on
 * `main` by another bump. The report said, on every tick:
 *
 *   🔴 Merge conflicts (mergeable_state: dirty) — resolving before approving
 *   ⏭️  Skipping (conflict, already attempted at this SHA)
 *
 * The remedy is the one Dependabot documents for exactly this: a
 * `@dependabot rebase` comment makes Dependabot re-create the bump on top of the
 * CURRENT base, which regenerates the lockfile with its own resolver — the tool
 * that actually understands the ecosystem. It is deterministic, it costs no
 * model tokens, and it MOVES THE HEAD, which releases every head-keyed record
 * (the `skip_reason`, the attempt tally, the budget tally) by itself.
 *
 * WHY A COMMENT AND NOT THE API. There is no REST endpoint to ask Dependabot to
 * rebase; the documented trigger is the comment, and it is what a human would
 * type. The comment is posted as the App installation, which is why it needs no
 * extra credential.
 *
 * WHY IT IS SAFE TO POST REPEATEDLY-BUT-NOT-OFTEN. Dependabot ignores a rebase
 * request on a branch that is already up to date, so a stray comment is
 * harmless; but a five-minute tick would post one forever, so the caller records
 * `rebase_requested_sha` and this module is only reached once per head.
 */

import type { GhClient } from "./scan.ts"

/** The exact comment body Dependabot's own documentation uses. */
export const DEPENDABOT_REBASE_COMMENT = "@dependabot rebase"

/**
 * Post the rebase request on `pr`.
 *
 * Returns the HTTP status so the caller can report what actually happened rather
 * than assuming the comment landed — the same discipline the rest of the worker
 * applies to every write.
 */
export async function requestDependabotRebase(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
): Promise<number> {
	const { status } = await api.request("POST", `/repos/${repo}/issues/${pr}/comments`, {
		token,
		json: { body: DEPENDABOT_REBASE_COMMENT },
	})
	return status
}

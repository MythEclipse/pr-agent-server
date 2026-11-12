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
 * WHY THE OWNER PAT AND NOT THE APP TOKEN. Dependabot only honours its slash
 * commands from an identity with PUSH access, and the App installation is not
 * one. The first live attempt posted the comment as the App and Dependabot
 * answered, on the PR, in public:
 *
 *   Sorry, only users with push access can use that command.
 *
 * A 201 from the comments API therefore proves only that a comment landed — not
 * that the rebase was requested. This is the same asymmetry `merge.ts` documents
 * for merges, and it gets the same treatment: the PAT is preferred, the App token
 * is a fallback for when no PAT is configured, and the caller is told which
 * identity spoke so a refusal is attributable.
 *
 * WHY A COMMENT AND NOT THE API. There is no REST endpoint to ask Dependabot to
 * rebase; the documented trigger is the comment, and it is what a human would
 * type.
 *
 * WHY IT IS SAFE TO POST REPEATEDLY-BUT-NOT-OFTEN. Dependabot ignores a rebase
 * request on a branch that is already up to date, so a stray comment is
 * harmless; but a five-minute tick would post one forever, so the caller records
 * `rebase_requested_sha` and this module is only reached once per head.
 */

import type { GhClient } from "./scan.ts"

/** Which credential posted the request. */
export type RebaseVia = "pat" | "app"

/**
 * The escalation ladder for a conflicted dependency bump.
 *
 * The ladder exists because the FIRST rung does not always apply, and the live
 * fleet proved it the same hour it shipped. `@dependabot rebase` answers three
 * different things, only one of which is "done":
 *
 *   - `Looks like this PR is already up-to-date with master! ... you can request
 *     @dependabot recreate` — the branch is not actually behind, so a rebase is a
 *     no-op and the conflict is with something else (web1#20).
 *   - `The dependabot.yml entry that created this PR has been deleted so this PR
 *     can't be rebased. Please close the PR so Dependabot can create a new one`
 *     — the ecosystem's config was removed or renamed, so the bump can never be
 *     rebuilt on this branch (ML-Tapi#4, #5).
 *   - nothing, i.e. it accepted the request and the branch will move.
 *
 * A single rung that records "requested, waiting" and never re-checks turns the
 * first two into a PERMANENT stall of a new shape — the very bug this module
 * exists to end. So the ladder escalates one rung per head, and the top rung
 * closes the PR so Dependabot opens a fresh one (or a human takes over), rather
 * than leaving a conflicted PR open forever.
 */
export type RebaseStep = "rebase" | "recreate" | "close"

/** The rungs, in order. `rebase_requested_sha`'s step is the index into this. */
export const REBASE_LADDER: readonly RebaseStep[] = ["rebase", "recreate", "close"]

/** The comment body each rung posts. Dependabot's own documented commands. */
export const REBASE_COMMENTS: Record<RebaseStep, string> = {
	rebase: "@dependabot rebase",
	recreate: "@dependabot recreate",
	close: "",
}

/** Kept as the rung-1 body, and as the name the tests and reports use. */
export const DEPENDABOT_REBASE_COMMENT = REBASE_COMMENTS.rebase
/** What `requestDependabotRebase` needs from the outside world. */
export type RebaseDeps = {
	/** Python `_fetch_gh_token()` — `""` means "no PAT configured". */
	fetchGhToken: () => string
}

export type RebaseResult = {
	/** The comments-API status. 2xx means the comment was created. */
	status: number
	/**
	 * The identity that spoke. `app` is reported, not refused, because a repo can
	 * legitimately have no PAT — but it is NOT evidence the rebase was accepted,
	 * and the caller's report line says so.
	 */
	via: RebaseVia
}

/**
 * Post one rung of the ladder on `pr`, preferring the owner PAT.
 *
 * Returns the status AND the identity so the caller can report what actually
 * happened rather than assuming the comment landed — the same discipline the rest
 * of the worker applies to every write.
 */
export async function requestDependabotRebase(
	deps: RebaseDeps,
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
	step: RebaseStep = "rebase",
): Promise<RebaseResult> {
	const json = { body: REBASE_COMMENTS[step] }
	const pat = deps.fetchGhToken()

	// PAT FIRST, because it is the only identity Dependabot will accept the
	// command from. A PAT that is present but unauthorised falls through to the
	// App rather than failing the tick: the comment is still worth posting, it
	// just may not be obeyed.
	if (pat) {
		const { status } = await api.request("POST", `/repos/${repo}/issues/${pr}/comments`, {
			token: pat,
			json,
		})
		if (status >= 200 && status < 300) return { status, via: "pat" }
		if (status !== 401 && status !== 403) return { status, via: "pat" }
	}

	const { status } = await api.request("POST", `/repos/${repo}/issues/${pr}/comments`, {
		token,
		json,
	})
	return { status, via: "app" }
}

/**
 * Close the PR so Dependabot can re-open a fresh bump from the CURRENT config.
 *
 * This is the top rung, and it is reached DETERMINISTICALLY — not by reading
 * Dependabot's prose. The ladder advances one rung per tick at the same head, so
 * arriving here means both `@dependabot rebase` and `@dependabot recreate` were
 * already issued for this exact SHA across two earlier ticks, and the head still
 * has not moved. That is the definition of "Dependabot cannot fix this branch".
 *
 * WHY NOT MATCH DEPENDABOT'S REPLY TEXT. A first cut gated this rung on the last
 * Dependabot reply containing "can't be rebased ... close the PR". It is the right
 * intent and the wrong mechanism: after `@dependabot recreate` the last reply is
 * often an unrelated acknowledgement ("OK, I won't notify you again about this
 * release..."), so the gate silently degraded the whole ladder into
 * "leaving this bump for a human" — the exact non-automatic outcome this module
 * exists to remove. Prose matching also breaks on any Dependabot copy-edit.
 *
 * The head not moving after two different commands is a fact the API states
 * directly, so the ladder is gated on that instead.
 *
 * Closing loses nothing: the bump is regenerated by the next Dependabot run from
 * the current config, and it is strictly better than an open PR no tool can merge.
 */
export async function closeUnrebasableBump(
	deps: RebaseDeps,
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
): Promise<RebaseResult> {
	const pat = deps.fetchGhToken()
	const json = { state: "closed" }
	if (pat) {
		const { status } = await api.request("PATCH", `/repos/${repo}/pulls/${pr}`, {
			token: pat,
			json,
		})
		if (status >= 200 && status < 300) return { status, via: "pat" }
		if (status !== 401 && status !== 403) return { status, via: "pat" }
	}
	const { status } = await api.request("PATCH", `/repos/${repo}/pulls/${pr}`, { token, json })
	return { status, via: "app" }
}

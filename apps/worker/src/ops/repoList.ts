/**
 * Every repo this token owns, read ACROSS PAGES.
 *
 * THE MEASURED BUG. `GET /user/repos?affiliation=owner&per_page=100` returns 100
 * repos per page and the caller read exactly one page, so the fleet stopped at
 * repo 100 with no error and no marker. Two callers did that — the nightly
 * `--sync-hooks` config sync and the `--audit-vulns` security audit — and both
 * report a COUNT, so a truncated list does not look truncated: it looks like a
 * smaller fleet. A repo past page 1 got no Dependabot config, no vulnerability
 * alerts, no security updates, and its advisories never appeared in an audit
 * that would have told anyone they existed.
 *
 * WHY `/user/repos` AND NOT `/users/{owner}/repos`: the public listing returns
 * only public repos (measured: 62 of 69 on this fleet), so private repos would
 * be silently unsynced — the failure is an absence, which is the hardest kind to
 * notice. `/user/repos` is authenticated and includes private ones.
 *
 * WHY `affiliation=owner` AND NOT EVERYTHING VISIBLE: these callers WRITE to
 * each repo (commit a Dependabot config, push a fix branch). Collaborator access
 * and org membership are not ownership, and a push to a repo this account does
 * not own is either refused or, worse, allowed and unwanted.
 */

import type { GhClient } from "../pr/scan.ts"

/** The fields the callers need, from the listing's repo objects. */
export type OwnedRepo = {
	fullName: string
	/** Where a fix branch is based. `main` is GitHub's own default. */
	defaultBranch: string
}

export type RepoListResult =
	| { ok: true; repos: OwnedRepo[] }
	| { ok: false; status: number; repos: OwnedRepo[] }

/** GitHub's maximum page size for this endpoint. */
const REPO_PAGE_SIZE = 100

/**
 * Hard stop: 20 pages is 2000 repos. Far above any real fleet, and a bound so a
 * proxy that ignores `?page=` cannot spin the walk forever — the same reason
 * every other paginator here is capped.
 */
const REPO_MAX_PAGES = 20

const asObject = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

const str = (value: unknown): string => (typeof value === "string" ? value : "")

/**
 * A listing row -> `OwnedRepo`, or `null` when the row cannot be acted on.
 *
 * ARCHIVED AND DISABLED REPOS ARE DROPPED HERE, at the edge, because every
 * caller would otherwise have to remember: Dependabot does not run on an
 * archived repo, and a push to one is refused. Reporting them as "in sync" (what
 * the sync used to do) is a claim about work that cannot happen — and opening a
 * security PR against a repo nobody can merge into is the same lie with more
 * steps.
 */
export function toOwnedRepo(row: unknown): OwnedRepo | null {
	const r = asObject(row)
	const fullName = str(r?.full_name)
	if (!fullName) return null
	if (r?.archived === true || r?.disabled === true) return null
	return {
		fullName,
		defaultBranch: str(r?.default_branch) || "main",
	}
}

/**
 * Read every page of the owner listing.
 *
 * Returns a DISCRIMINATED RESULT, not a bare array: "this account owns no repos"
 * and "the second page failed" are opposite facts, and the callers' next move
 * differs — an empty fleet is a report, a failed page means the audit must not
 * conclude anything about the repos it never saw. A partial list is returned
 * WITH `ok: false` so the caller can still work on what it has while saying out
 * loud that the fleet was not fully read.
 */
export async function listAllOwnedRepos(api: GhClient, token: string): Promise<RepoListResult> {
	const repos: OwnedRepo[] = []
	const seen = new Set<string>()
	for (let page = 1; page <= REPO_MAX_PAGES; page += 1) {
		const res = await api.request(
			"GET",
			`/user/repos?affiliation=owner&per_page=${REPO_PAGE_SIZE}&page=${page}&sort=full_name`,
			{ token },
		)
		if (res.status !== 200 || !Array.isArray(res.data)) {
			return { ok: false, status: res.status, repos }
		}
		const rows = res.data
		for (const row of rows) {
			const repo = toOwnedRepo(row)
			// `sort=full_name` is stable, but a repo created between two page
			// requests shifts everything after it by one and can repeat a row.
			// Deduping by name is what keeps a shift from becoming a double sync.
			if (!repo || seen.has(repo.fullName)) continue
			seen.add(repo.fullName)
			repos.push(repo)
		}
		if (rows.length < REPO_PAGE_SIZE) return { ok: true, repos }
	}
	// The cap ended the walk, so the list is whole only if it happens to be
	// exactly REPO_MAX_PAGES * REPO_PAGE_SIZE long — which cannot be proven, and
	// an unprovable "complete" is the bug this module exists to fix.
	return { ok: false, status: 200, repos }
}

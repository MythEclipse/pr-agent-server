// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code; GitHub payloads are untyped JSON
/**
 * Open-PR fan-out — port of `scripts/pr-queue-worker.py` lines 301-316
 * (`gather_open_prs`).
 *
 * The App has no webhook delivery of its own here: the worker asks GitHub who
 * the App is installed on, then for each installation which repositories it can
 * see, then for the open PRs of each of those. Each PR is returned with the
 * installation token that can act on it, because every later step (comment,
 * review, close, merge) reuses that token.
 *
 * WHY THE TYPES ARE STRUCTURAL, NOT `GitHubApi`:
 * the Python reaches for a module-level `gh_api`; here the client is a
 * parameter. Narrowing it to the concrete class would force every test to build
 * a real `GitHubApi` (an RSA key, a listener) to exercise a pure fan-out rule.
 * `GitHubApi` satisfies these shapes structurally, so production wiring is
 * unchanged and the tests stay hermetic.
 *
 * DEFENSIVE SHAPE GUARDS, not naive translations: Python's
 * `isinstance(installs, list)` / `repos.get("repositories", [])` are reproduced
 * as real checks, because `request` returns `{}` on a transport failure (github.ts)
 * and `repos.get` on a non-dict would raise inside a cron tick. The one place
 * Python WOULD raise is a non-dict `repos`; the guard is a deliberate, safe
 * improvement, not a behaviour change on any path Python survives.
 */

/** The subset of `GitHubApi.request` this module uses. */
export type GhClient = {
	request(
		method: string,
		path: string,
		opts?: { token?: string; json?: unknown },
	): Promise<{ status: number; data: any; link?: string }>
}

/** `GhClient` plus the token minting `gatherOpenPrs` needs. */
export type GhAppClient = GhClient & {
	installationToken(installId: number): Promise<string>
}

/** Python's `(token, repo_full, pr)` triple, as an object. */
export type OpenPr = { token: string; repo: string; pr: any }

/** Python `str.title` is irrelevant here; this is just a printable field. */
const repoField = (repo: any): string | undefined =>
	typeof repo?.full_name === "string" ? repo.full_name : undefined

/** GitHub's page size ceiling for these endpoints. */
const PER_PAGE = 100

/**
 * Read every page of an `installation/repositories` listing.
 *
 * WHY THIS EXISTS. `GET /installation/repositories` returns `total_count` for the
 * whole installation but only ONE page of `repositories` — 30 by default. The
 * worker asked once, without `per_page`, and trusted the body. Measured on
 * MythEclipse (installation 177719826) on 2026-11-12: `total_count` was 51 while
 * 30 were returned, so **21 repositories were never scanned at all** — including
 * `pr-agent-server`, `TeleUploader`, `mcpedia` and `zesdex`, which is exactly
 * where the four open Dependabot PRs were sitting. The queue reported "Found 2
 * open PR(s)" while four more were invisible, and the fix-state file held entries
 * for only two repos.
 *
 * The failure is silent by construction: a short page is indistinguishable from a
 * small installation, so no status code, no error and no log line revealed it.
 *
 * Pagination is by `page`; the loop stops when a page returns nothing or when the
 * accumulated count reaches `total_count` (whichever comes first, so a server that
 * ignores `page` cannot loop forever).
 */
async function listInstallationRepos(api: GhClient, token: string): Promise<any[]> {
	const out: any[] = []
	for (let page = 1; page <= 100; page++) {
		const { data } = await api.request(
			"GET",
			`/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
			{ token },
		)
		if (data === null || typeof data !== "object") break
		const batch = Array.isArray((data as any).repositories) ? (data as any).repositories : []
		if (!batch.length) break
		out.push(...batch)
		const total = typeof (data as any).total_count === "number" ? (data as any).total_count : 0
		// `total_count` is the AUTHORITY when present: a server that caps a page
		// below `per_page` (GitHub does exactly that at 30 for some App endpoints)
		// would otherwise look "short" and end the loop after one page — which is
		// the very truncation this function exists to fix. Only fall back to the
		// page-length heuristic when the body carries no count.
		if (total > 0) {
			if (out.length >= total) break
		} else if (batch.length < PER_PAGE) break
	}
	return out
}

/**
 * Read every page of an open-PR listing for one repo.
 *
 * Same defect, same shape: `per_page=20` was hard-coded and `link` was already
 * being returned by `request` but never read. A repo with 21+ open PRs had its
 * tail silently dropped. `link` is preferred when present because it is GitHub's
 * own "there is more" signal; the count check is the fallback for a client that
 * does not surface the header.
 */
async function listOpenPrs(api: GhClient, token: string, fullName: string): Promise<any[]> {
	const out: any[] = []
	for (let page = 1; page <= 100; page++) {
		const { data, link } = await api.request(
			"GET",
			`/repos/${fullName}/pulls?state=open&per_page=${PER_PAGE}&page=${page}&sort=updated`,
			{ token },
		)
		if (!Array.isArray(data)) break
		out.push(...data)
		if (data.length < PER_PAGE) break
		if (typeof link === "string" && !link.includes('rel="next"')) break
	}
	return out
}

/**
 * Python `gather_open_prs()` (lines 301-316).
 *
 * `GET /app/installations` → per installation
 * `GET /installation/repositories` → `GET /repos/{full}/pulls?state=open&per_page=20&sort=updated`.
 *
 * Two filters are load-bearing, both copied exactly:
 *   - an installation whose token is empty is SKIPPED (line 308-309): a failed
 *     token mint would otherwise produce calls that all 401 and look like a
 *     repo with no PRs, which is a different (and wrong) conclusion;
 *   - a pulls body that is not an array contributes nothing (line 313-314):
 *     a rate-limit or 404 object is not "zero PRs", but acting on it as such
 *     would silently skip the PRs the worker exists to process.
 *
 * `status` is deliberately NOT branched on, matching the Python: `gh_api`
 * returns the status and the caller ignores it (line 303, 310, 312 discard the
 * first tuple element). Branching here would be a behaviour change, and the
 * shape guards already make the degenerate responses safe.
 */
export async function gatherOpenPrs(api: GhAppClient): Promise<OpenPr[]> {
	const results: OpenPr[] = []
	const { data: installs } = await api.request("GET", "/app/installations")
	if (!Array.isArray(installs)) return results // Python lines 304-305
	for (const inst of installs) {
		const id = (inst as { id?: number })?.id
		if (typeof id !== "number") continue // guard: `inst["id"]` would throw
		const token = await api.installationToken(id)
		if (!token) continue // Python lines 308-309
		// PAGINATED: the body's `total_count` can exceed the page returned.
		const list = await listInstallationRepos(api, token)
		for (const repo of list) {
			const fullName = repoField(repo)
			if (!fullName) continue // guard: `repo['full_name']` would throw
			const prs = await listOpenPrs(api, token, fullName)
			for (const pr of prs) results.push({ token, repo: fullName, pr })
		}
	}
	return results
}

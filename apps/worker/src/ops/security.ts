// biome-ignore-all lint/suspicious/noExplicitAny: GitHub API payloads are untyped JSON
/**
 * Security fixes & Dependabot vulnerability alerts synchronization across repos.
 *
 * Implements enablement and checks for:
 * 1. PUT /repos/{owner}/{repo}/vulnerability-alerts (enables Dependabot alert scanning)
 * 2. PUT /repos/{owner}/{repo}/automated-security-fixes (enables Dependabot security update PRs)
 * 3. GET /repos/{owner}/{repo}/dependabot/alerts?state=open (audit open security advisories)
 */

import type { GhClient } from "../pr/scan.ts"

export type SecurityStep = { ok: boolean; line: string }

/**
 * Enable Dependabot vulnerability alerts on a repo.
 * PUT /repos/{owner}/{repo}/vulnerability-alerts returns 204 No Content on success.
 */
export async function enableVulnerabilityAlerts(
	api: GhClient,
	repo: string,
	token: string,
): Promise<SecurityStep> {
	// Check existing status: GET returns 204 if enabled, 404 if disabled
	const current = await api.request("GET", `/repos/${repo}/vulnerability-alerts`, { token })
	if (current.status === 204) {
		return { ok: false, line: `⏭️  ${repo}: vulnerability alerts already enabled` }
	}

	const res = await api.request("PUT", `/repos/${repo}/vulnerability-alerts`, { token })
	if (res.status === 204 || res.status === 200) {
		return { ok: true, line: `🛡️  ${repo}: vulnerability alerts enabled` }
	}
	return {
		ok: false,
		line: `⏭️  ${repo}: vulnerability alerts not enabled (HTTP ${res.status})`,
	}
}

/**
 * Enable GitHub Automated Security Fixes (Dependabot security PR generation).
 * PUT /repos/{owner}/{repo}/automated-security-fixes returns 204 No Content on success.
 */
export async function enableAutomatedSecurityFixes(
	api: GhClient,
	repo: string,
	token: string,
): Promise<SecurityStep> {
	// Check existing status: GET returns 200 with { enabled: boolean } or 404
	const current = await api.request("GET", `/repos/${repo}/automated-security-fixes`, { token })
	if (current.status === 200 && current.data?.enabled === true && !current.data?.paused) {
		return { ok: false, line: `⏭️  ${repo}: automated security fixes already enabled` }
	}

	const res = await api.request("PUT", `/repos/${repo}/automated-security-fixes`, { token })
	if (res.status === 204 || res.status === 200) {
		return { ok: true, line: `🛡️  ${repo}: automated security fixes enabled` }
	}
	return {
		ok: false,
		line: `⏭️  ${repo}: automated security fixes not enabled (HTTP ${res.status})`,
	}
}

export type DependabotAlert = {
	number: number
	state: "open" | "fixed" | "dismissed"
	dependency: {
		package: {
			ecosystem: string
			name: string
		}
		manifest_path: string
		scope?: string
		relationship?: string
	}
	security_advisory: {
		ghsa_id: string
		cve_id: string | null
		summary: string
		severity: string
	}
	security_vulnerability: {
		package: {
			ecosystem: string
			name: string
		}
		severity: string
		vulnerable_version_range: string
		first_patched_version: {
			identifier: string
		} | null
	}
	url: string
	html_url: string
	created_at: string
}

/**
 * The page size GitHub caps this endpoint at, and the hard stop on pagination.
 *
 * THE CAP IS NOT COSMETIC. This endpoint is paginated, and the original code
 * read ONE page and stopped — so a fleet audit reported 317 open alerts when the
 * real number was 630. Nearly half the problem was invisible, which is exactly
 * the failure mode a security audit must not have.
 *
 * CURSOR, NOT `page`. This endpoint rejects `?page=N` with
 * `HTTP 400: Pagination using the 'page' parameter is not supported` — for every
 * repo, which reads like an auth failure if you only look at the status. It pages
 * by `before`/`after` cursor and advertises the next URL in the `Link` header.
 * A first attempt at this fix sent `?page=1` and turned a working scan into 62
 * consecutive 400s that the old code reported as "no vulnerabilities found".
 *
 * 50 pages is 5000 alerts: far above any real fleet, and a hard stop so a
 * malformed `Link` cannot spin forever.
 */
const ALERT_PAGE_SIZE = 100
const ALERT_MAX_PAGES = 50

export type AlertsResult =
	| { ok: true; alerts: DependabotAlert[] }
	| { ok: false; status: number; alerts: DependabotAlert[] }

/**
 * The `rel="next"` target out of a `Link` header, as a path this client can call.
 *
 * `request()` prepends its own base URL, so an absolute `https://api.github.com/…`
 * cursor has to be reduced to a path — passing the absolute URL through would
 * produce `https://api.github.comhttps://api.github.com/…`.
 */
export function nextPagePath(link: string | undefined): string | undefined {
	if (!link) return undefined
	for (const part of link.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)
		if (!match) continue
		const url = match[1].trim()
		const scheme = /^https?:\/\/[^/]+(\/.*)$/.exec(url)
		return scheme ? scheme[1] : url
	}
	return undefined
}

/**
 * Fetch every open Dependabot alert for a repository, following the cursor.
 *
 * Returns a DISCRIMINATED RESULT, not a bare array, because "no alerts" and
 * "the call failed" are opposite facts and the caller's next move differs: an
 * empty list means the repo is clean, a failure means the caller must not
 * conclude anything — in particular it must not overwrite a Dependabot config
 * with one derived from an empty alert list.
 */
export async function fetchOpenDependabotAlertsResult(
	api: GhClient,
	repo: string,
	token: string,
): Promise<AlertsResult> {
	const all: DependabotAlert[] = []
	let path: string | undefined =
		`/repos/${repo}/dependabot/alerts?state=open&per_page=${ALERT_PAGE_SIZE}`
	for (let page = 0; page < ALERT_MAX_PAGES && path !== undefined; page += 1) {
		const res: { status: number; data: unknown; link?: string } = await api.request("GET", path, {
			token,
		})
		if (res.status !== 200 || !Array.isArray(res.data)) {
			// A failure on the first page is a failure. A failure on a LATER page is
			// a partial answer: reporting the pages we did get is better than
			// discarding them, but it is still not "ok" — so it is surfaced.
			return { ok: false, status: res.status, alerts: all }
		}
		all.push(...(res.data as DependabotAlert[]))
		// The cursor is the ONLY way forward; absent means this was the last page.
		// A short page is also the end, and stops without spending a request.
		path =
			(res.data as DependabotAlert[]).length < ALERT_PAGE_SIZE ? undefined : nextPagePath(res.link)
	}
	return { ok: true, alerts: all }
}

/**
 * Fetch open Dependabot alerts for a repository.
 *
 * Thin wrapper over `fetchOpenDependabotAlertsResult` for callers that only
 * want the list. PREFER THE RESULT FORM anywhere the answer decides a WRITE:
 * this one collapses "failed" into "none", which would let a failed read
 * overwrite a repo's Dependabot config with a truncated one.
 */
export async function fetchOpenDependabotAlerts(
	api: GhClient,
	repo: string,
	token: string,
): Promise<DependabotAlert[]> {
	const res = await fetchOpenDependabotAlertsResult(api, repo, token)
	return res.alerts
}

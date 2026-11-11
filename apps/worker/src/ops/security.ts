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
 * Fetch open Dependabot alerts for a repository.
 */
export async function fetchOpenDependabotAlerts(
	api: GhClient,
	repo: string,
	token: string,
): Promise<DependabotAlert[]> {
	const res = await api.request("GET", `/repos/${repo}/dependabot/alerts?state=open&per_page=100`, {
		token,
	})
	if (res.status !== 200 || !Array.isArray(res.data)) {
		return []
	}
	return res.data as DependabotAlert[]
}

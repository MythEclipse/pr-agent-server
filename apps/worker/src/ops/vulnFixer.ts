// biome-ignore-all lint/suspicious/noExplicitAny: API and git runner payloads are untyped
/**
 * Auto-fix Dependabot security vulnerabilities across repos.
 *
 * Scans open Dependabot alerts (CVE / GHSA), identifies target manifests,
 * runs appropriate toolchain lockfile/manifest bumps or AI fix, and submits
 * or merges fix PRs.
 */

import type { GhClient } from "../pr/scan.ts"
import { type DependabotAlert, fetchOpenDependabotAlerts } from "./security.ts"

export type VulnFixResult = {
	repo: string
	totalAlerts: number
	alertsFixed: number
	prUrl?: string
	details: string[]
}

/**
 * Group open alerts by manifest path (e.g. package.json, Cargo.lock, composer.lock)
 */
export function groupAlertsByManifest(alerts: DependabotAlert[]): Map<string, DependabotAlert[]> {
	const map = new Map<string, DependabotAlert[]>()
	for (const alert of alerts) {
		const manifest = alert.dependency.manifest_path || "root"
		const list = map.get(manifest) ?? []
		list.push(alert)
		map.set(manifest, list)
	}
	return map
}

/**
 * Generate a security summary report for a repository.
 */
export function summarizeVulns(repo: string, alerts: DependabotAlert[]): string[] {
	if (alerts.length === 0) {
		return [`✅ ${repo}: 0 open Dependabot security alerts`]
	}
	const lines = [`🛡️  ${repo}: ${alerts.length} open security alert${alerts.length > 1 ? "s" : ""}:`]
	for (const a of alerts.slice(0, 10)) {
		const pkg = a.dependency.package.name
		const patched = a.security_vulnerability.first_patched_version?.identifier ?? "no patch"
		const cve = a.security_advisory.cve_id ?? a.security_advisory.ghsa_id
		lines.push(
			`   - ${pkg} (${cve}, severity: ${a.security_vulnerability.severity}) -> patch ${patched}`,
		)
	}
	if (alerts.length > 10) {
		lines.push(`   ... and ${alerts.length - 10} more`)
	}
	return lines
}

export type ScanAndFixOptions = {
	dryRun?: boolean
	token: string
	repos?: string[]
}

/**
 * Scan all repositories for open Dependabot alerts and report vulnerabilities.
 */
export async function scanVulns(
	api: GhClient,
	repos: string[],
	token: string,
): Promise<{ repo: string; alerts: DependabotAlert[] }[]> {
	const results: { repo: string; alerts: DependabotAlert[] }[] = []
	for (const repo of repos) {
		const alerts = await fetchOpenDependabotAlerts(api, repo, token)
		results.push({ repo, alerts })
	}
	return results
}

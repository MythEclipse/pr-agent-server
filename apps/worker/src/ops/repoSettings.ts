// Enforce the security settings, do not just report them.
//
// `security.ts` could already ENABLE vulnerability alerts and automated security
// fixes, and the nightly `--sync-hooks` called it. What was missing:
//
//   - SECRET SCANNING AND PUSH PROTECTION. Never touched. A repo without them
//     accepts a committed token and nobody is told; with push protection the
//     commit is refused at the client. That is the difference between a finding
//     and an incident.
//   - DRIFT. The nightly run reported "already enabled" as `⏭️` and the caller
//     counts skips as fine — correct — but nothing ever compared the fleet
//     against a desired state, so a repo that had a setting turned OFF looked
//     identical to one that never needed it.
//   - THE REASON FOR A REFUSAL. `HTTP 403` on `PUT /vulnerability-alerts` means
//     the App lacks the permission, not that the repo is fine. Reporting both as
//     `⏭️` is how a fleet-wide gap stays invisible.
//
// Everything here is idempotent and only ever ENABLES. Nothing is disabled: a
// setting a human turned on for a reason stays on.

import type { GhClient } from "../pr/scan.ts"
import {
	enableAutomatedSecurityFixes,
	enableVulnerabilityAlerts,
	type SecurityStep,
} from "./security.ts"

export type RepoSettingState = {
	repo: string
	/** Whether the API could be asked at all (a 403 here means a permission gap). */
	readable: boolean
	vulnerabilityAlerts: boolean | null
	automatedSecurityFixes: boolean | null
	secretScanning: boolean | null
	secretScanningPushProtection: boolean | null
}

export type EnforceResult = {
	steps: SecurityStep[]
	/**
	 * Repos where a setting is off and the run could not turn it on because of a
	 * PERMISSION or transport problem — something an operator can fix.
	 */
	blocked: string[]
	/**
	 * Repos where the setting is off because GitHub does not offer it there.
	 *
	 * MEASURED on the first live run: 4 repos enabled, 7 answered `HTTP 422` for
	 * secret scanning. That is not a failure — secret scanning is free on public
	 * repos and needs GitHub Advanced Security on private ones, and no amount of
	 * permission fixes it. Reporting it as `blocked` made the unit exit non-zero
	 * and fire `OnFailure=` on every single run, which is exactly the alert fatigue
	 * that makes a real failure invisible.
	 */
	unavailable: string[]
	/** True when no repo is `blocked`. */
	converged: boolean
}

/**
 * Read one repo's security posture.
 *
 * THREE DIFFERENT ENDPOINTS, because GitHub does not expose them together:
 * `/repos/{r}` carries `security_and_analysis` (secret scanning + push
 * protection), `/vulnerability-alerts` answers 204 when enabled and 404 when not,
 * and `/automated-security-fixes` answers `{enabled, paused}`.
 */
export async function readSettings(
	api: GhClient,
	repo: string,
	token: string,
): Promise<RepoSettingState> {
	const repoRes = await api.request("GET", `/repos/${repo}`, { token })
	const analysis = repoRes.data?.security_and_analysis ?? {}
	const alerts = await api.request("GET", `/repos/${repo}/vulnerability-alerts`, { token })
	const asf = await api.request("GET", `/repos/${repo}/automated-security-fixes`, { token })

	// A 404 on the alerts endpoint means "not enabled" — that is an answer. Any
	// other non-2xx (403, 451 for a repo with the feature unavailable) means the
	// question could not be asked, and the two must not be conflated.
	const readable = repoRes.status === 200
	return {
		repo,
		readable,
		vulnerabilityAlerts: alerts.status === 204 ? true : alerts.status === 404 ? false : null,
		automatedSecurityFixes:
			asf.status === 200
				? asf.data?.enabled === true && !asf.data?.paused
				: asf.status === 404
					? false
					: null,
		secretScanning: analysis.secret_scanning?.status === "enabled" ? true : readable ? false : null,
		secretScanningPushProtection:
			analysis.secret_scanning_push_protection?.status === "enabled"
				? true
				: readable
					? false
					: null,
	}
}

/**
 * Turn secret scanning and push protection on.
 *
 * `PATCH /repos/{r}` with `security_and_analysis`, which needs `administration`
 * write. It is sent only when something is actually off, so the steady state
 * makes no writes at all — a nightly job that PATCHes every repo every night is
 * a nightly chance to break one of them.
 */
export async function enableSecretScanning(
	api: GhClient,
	repo: string,
	token: string,
	state: RepoSettingState,
	dry: boolean,
): Promise<SecurityStep> {
	const needScan = state.secretScanning === false
	const needPush = state.secretScanningPushProtection === false
	if (!needScan && !needPush) {
		return { ok: false, line: `⏭️  ${repo}: secret scanning + push protection already enabled` }
	}
	if (state.readable === false) {
		return {
			ok: false,
			line: `⚠️  ${repo}: cannot read repo settings (permission: administration)`,
		}
	}
	if (dry) {
		const what = [needScan ? "secret scanning" : "", needPush ? "push protection" : ""].filter(
			Boolean,
		)
		return { ok: true, line: `🔐 ${repo}: would enable ${what.join(" + ")}` }
	}

	const body: Record<string, unknown> = { security_and_analysis: {} }
	const analysis = body.security_and_analysis as Record<string, unknown>
	if (needScan) analysis.secret_scanning = { status: "enabled" }
	if (needPush) analysis.secret_scanning_push_protection = { status: "enabled" }

	const res = await api.request("PATCH", `/repos/${repo}`, { token, json: body })
	if (res.status === 200) {
		const what = [needScan ? "secret scanning" : "", needPush ? "push protection" : ""].filter(
			Boolean,
		)
		return { ok: true, line: `🔐 ${repo}: enabled ${what.join(" + ")}` }
	}
	if (res.status === 422) {
		// Not offered here: a private repo without GitHub Advanced Security. Named
		// honestly so nobody goes looking for a permission that does not exist.
		return {
			ok: false,
			unavailable: true,
			line: `⏭️  ${repo}: secret scanning not available (HTTP 422 — needs GitHub Advanced Security on a private repo)`,
		}
	}
	return {
		ok: false,
		line:
			`⚠️  ${repo}: secret scanning NOT enabled (HTTP ${res.status})` +
			(res.status === 403 ? " — the App needs `administration: write`" : ""),
	}
}

/**
 * Converge the whole fleet, one repo at a time.
 *
 * `blocked` is the list an operator actually needs: a repo where a setting is
 * off and the run could not turn it on. Everything else is a skip or a success.
 */
export async function enforceRepoSettings(
	api: GhClient,
	deps: { repos: string[]; token: string; dry: boolean; log: (line: string) => void },
): Promise<EnforceResult> {
	const steps: SecurityStep[] = []
	const blocked: string[] = []
	const unavailable: string[] = []

	for (const repo of deps.repos) {
		const state = await readSettings(api, repo, deps.token)
		const desired =
			state.vulnerabilityAlerts === true &&
			state.automatedSecurityFixes === true &&
			state.secretScanning === true &&
			state.secretScanningPushProtection === true
		if (desired) {
			steps.push({ ok: false, line: `⏭️  ${repo}: all four security settings already on` })
			continue
		}

		// The two Dependabot switches keep their own helpers: they have their own
		// endpoints, and their own messages are already measured.
		if (state.vulnerabilityAlerts !== true) {
			steps.push(
				deps.dry
					? { ok: true, line: `🛡️  ${repo}: would enable vulnerability alerts` }
					: await enableVulnerabilityAlerts(api, repo, deps.token),
			)
		}
		if (state.automatedSecurityFixes !== true) {
			steps.push(
				deps.dry
					? { ok: true, line: `🛡️  ${repo}: would enable automated security fixes` }
					: await enableAutomatedSecurityFixes(api, repo, deps.token),
			)
		}
		steps.push(await enableSecretScanning(api, repo, deps.token, state, deps.dry))

		// Re-read rather than trusting the writes: a PUT can answer 204 and still
		// leave the setting off when the App's permission is downgraded, and the
		// only signal that matters is the state afterwards.
		const after = await readSettings(api, repo, deps.token)
		// The Dependabot switches are always available; the secret-scanning pair may
		// not be, and a repo where the feature does not exist is not a failure.
		const stillOff = [
			after.vulnerabilityAlerts === true ? "" : "vulnerability alerts",
			after.automatedSecurityFixes === true ? "" : "automated security fixes",
		].filter(Boolean)
		const scanStillOff =
			after.secretScanning !== true || after.secretScanningPushProtection !== true
		if (stillOff.length > 0) {
			blocked.push(`${repo}: ${stillOff.join(", ")}`)
		} else if (scanStillOff) {
			const step = steps[steps.length - 1]
			if (step?.unavailable === true) unavailable.push(`${repo}: secret scanning`)
			else blocked.push(`${repo}: secret scanning, push protection`)
		}
	}

	for (const step of steps) deps.log(step.line)
	return { steps, blocked, unavailable, converged: blocked.length === 0 }
}

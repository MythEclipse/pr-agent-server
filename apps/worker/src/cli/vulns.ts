import { acquireWithWait, LOCK_FILE } from "../lock.ts"
import { dependabotTemplateBody, runSyncHooks } from "../ops/syncHooks.ts"
import {
	derivableLanes,
	hasPatch,
	missingLanes,
	repoLanes,
	scanVulns,
	summarizeVulns,
} from "../ops/vulnFixer.ts"
import { Report } from "../report.ts"
import type { WorkerCliContext } from "./context.ts"
import { syncHooksExitCode } from "./sync.ts"

/**
 * `--fix-vulns`: make the open advisories ACTIONABLE, then report the coverage.
 *
 * WHAT THIS IS NOT. It does not bump manifests or open PRs itself. Dependabot
 * does that, and it does it well; a second bump engine here would duplicate it
 * badly and fight it on the same branches. What this fixes is the thing standing
 * in Dependabot's way: a lane that names the manifest the alert is on.
 *
 * THE MEASURED GAP. 478 of 630 open alerts across this fleet sat on manifests no
 * `updates:` lane named — nested `requirements.txt`, `rust/Cargo.lock`,
 * `modul6/modul6/pom.xml`. With no lane, "automated security fixes" is switched
 * on and watches nothing, so the advisory is raised and can never become a PR.
 * This mode derives a lane per `(ecosystem, directory)` from each repo's own
 * alerts and writes the config that carries them.
 *
 * Runs the SAME writer as `--sync-hooks`, deliberately: two writers of one file
 * would overwrite each other nightly. It is the same work with a different
 * report — a coverage table instead of a per-step log.
 *
 * Gated like `--sync-hooks`, for the same reason: it rewrites fleet-wide config.
 */
export async function fixVulns(argv: string[], context: WorkerCliContext): Promise<number> {
	const { buildDeps, webhookSecret, setReleaseHeld } = context
	const gate = process.env.PR_AGENT_SYNC_HOOKS
	if (gate !== "1") {
		console.error(
			"pr-queue-worker: --fix-vulns is gated. Set PR_AGENT_SYNC_HOOKS=1 after " +
				"reviewing apps/worker/src/ops/templates/ — it rewrites Dependabot config " +
				"across every repo this token can see.",
		)
		return 1
	}
	const dry = argv.includes("--dry")
	// WAIT, do not fail — same reason as `syncHooks`: a nightly-style job colliding
	// with a 36-second tick must not report a failure.
	const lock = await acquireWithWait(LOCK_FILE)
	if (!lock) {
		console.log("another pr-queue-worker run held the lock for 2 minutes — giving up")
		return 1
	}
	setReleaseHeld(() => lock.release())
	try {
		const deps = buildDeps({ dry, report: new Report() })
		const res = await runSyncHooks({
			api: deps.api,
			ghToken: deps.fetchGhToken(),
			webhookSecret,
			syncSecurity: true,
			deriveVulnLanes: true,
			dry,
		})

		const coverage = res.lanes ?? []
		const unreachable = coverage.reduce((sum, c) => sum + c.unreachable, 0)
		const unfixable = coverage.reduce((sum, c) => sum + c.unfixable, 0)
		const totalAlerts = coverage.reduce((sum, c) => sum + c.alerts, 0)
		const addedLanes = coverage.reduce((sum, c) => sum + c.added.length, 0)

		// The step log is long and mostly "already in sync". Print only the repos
		// that had something to say, then the table — the table is the report.
		for (const line of res.lines) {
			if (line.startsWith("⚠️")) console.log(line)
		}
		for (const c of coverage) {
			if (c.unreachable === 0) continue
			console.log(
				`${dry ? "DRY " : ""}${c.repo}: ${c.alerts} open alert(s), ${c.unreachable} fixable and unreachable -> ${c.added.length} lane(s)`,
			)
			for (const lane of c.added) {
				console.log(`      + ${lane.ecosystem} ${lane.directory} (${lane.fixable} fixable)`)
			}
		}
		console.log(
			dry
				? `vuln-fix: DRY RUN — ${totalAlerts} alert(s) across ${coverage.length} repo(s); ${unreachable} fixable alert(s) would become reachable via ${addedLanes} lane(s). Nothing written.`
				: `vuln-fix: ${totalAlerts} alert(s) across ${coverage.length} repo(s); ${unreachable} fixable alert(s) made reachable via ${addedLanes} lane(s).`,
		)
		// The no-patch count is stated, not hidden. Those advisories are not a
		// backlog anyone can work off — they are waiting on upstream — and the
		// user's instruction was to skip them rather than chase them.
		if (unfixable > 0) {
			console.log(
				`vuln-fix: ${unfixable} alert(s) skipped — no patched version published, so there is nothing to upgrade to. They are re-checked every run and a lane appears automatically once upstream ships a fix.`,
			)
		}
		if (unreachable === 0) {
			console.log(
				"vuln-fix: every fixable alert already sits on a watched manifest — Dependabot owns the rest.",
			)
		}
		return syncHooksExitCode(res.lines)
	} finally {
		lock.release()
		setReleaseHeld(null)
	}
}

/**
 * Audit and report Dependabot security vulnerabilities across repos.
 */
export async function auditVulns(argv: string[], context: WorkerCliContext): Promise<number> {
	const { buildDeps } = context
	const deps = buildDeps({ dry: argv.includes("--dry"), report: new Report() })
	const token = deps.fetchGhToken()
	if (!token) {
		console.error("vuln-scan: no GitHub token available")
		return 1
	}
	// Fetch list of repositories
	const { status, data } = await deps.api.request(
		"GET",
		"/user/repos?affiliation=owner&per_page=100",
		{ token },
	)
	if (status !== 200 || !Array.isArray(data)) {
		console.error(`vuln-scan: failed to list repos (HTTP ${status})`)
		return 1
	}
	const repos = data
		.map((r: unknown) =>
			typeof r === "object" && r !== null && "full_name" in r ? String(r.full_name ?? "") : "",
		)
		.filter(Boolean)
	console.log(`🔍 Scanning Dependabot security alerts across ${repos.length} repositories...`)
	const results = await scanVulns(deps.api, repos, token)
	// An audit that only counts advisories answers the wrong question. The one
	// that matters is how many of them DEPENDABOT CAN ACT ON — an alert on a
	// manifest no lane names cannot become a PR, so it will still be open in a
	// month no matter what the count says.
	//
	// COVERAGE IS PER REPO, read from the repo's OWN config. Derived lanes live
	// there, not in the shared template; comparing against the template reported
	// every derived lane as missing and would have called a fully-fixed fleet
	// broken forever.
	const template = dependabotTemplateBody()
	let totalVulns = 0
	let unreachable = 0
	let unfixable = 0
	let unreadable = 0
	const unreadableByStatus = new Map<number, number>()
	for (const { repo, alerts, ok, status } of results) {
		// A REPO THAT COULD NOT BE READ IS NOT A CLEAN REPO. Reporting it as clean
		// is how this audit once printed "No open vulnerabilities found across any
		// repository" for a fleet carrying 630.
		if (!ok) {
			unreadable += 1
			unreadableByStatus.set(status, (unreadableByStatus.get(status) ?? 0) + 1)
			console.log(`   ⚠️  ${repo}: alerts unreadable (HTTP ${status}) — NOT counted as clean`)
			continue
		}
		if (alerts.length > 0) {
			totalVulns += alerts.length
			unfixable += alerts.filter((a) => !hasPatch(a)).length
			for (const line of summarizeVulns(repo, alerts)) {
				console.log(line)
			}
			const lanes = await repoLanes(deps.api, repo, token, template)
			const missing = missingLanes(derivableLanes(alerts), lanes)
			const dead = missing.reduce((sum, lane) => sum + lane.fixable, 0)
			if (dead > 0) {
				unreachable += dead
				console.log(
					`   ⚠️  ${dead} of ${alerts.length} unreachable — no lane covers: ${missing
						.map((lane) => `${lane.ecosystem} ${lane.directory}`)
						.join(", ")}`,
				)
			}
		}
	}
	if (totalVulns === 0 && unreadable === 0) {
		console.log("✅ No open Dependabot vulnerabilities found across any repository!")
	} else if (totalVulns === 0) {
		console.log(
			`❌ Could not read alerts for ${unreadable}/${results.length} repositor${results.length === 1 ? "y" : "ies"} — the audit is INCOMPLETE, not clean.`,
		)
	} else {
		console.log(`⚠️ Total ${totalVulns} open Dependabot vulnerabilities found.`)
		// The actionables are stated separately from the rest. 32 of this fleet's
		// 598 have no published fix, so "598 vulnerabilities" overstates the work
		// owed by that much and makes a converged fleet look neglected.
		const actionable = totalVulns - unfixable
		console.log(
			`   ${actionable} have a published fix; ${unfixable} have none — no patched version exists, so nothing can be upgraded and they are skipped.`,
		)
		if (unreachable > 0) {
			console.log(
				`⚠️ ${unreachable} fixable alert(s) sit on manifests no Dependabot lane names — Dependabot cannot open a PR for those. Run --fix-vulns to add the lanes.`,
			)
		} else {
			console.log("✅ Every fixable alert sits on a watched manifest — Dependabot owns the rest.")
		}
	}
	if (unreadable > 0) {
		const detail = [...unreadableByStatus.entries()]
			.map(([status, count]) => `HTTP ${status} x${count}`)
			.join(", ")
		console.log(`⚠️ ${unreadable}/${results.length} repositor(ies) could not be read (${detail}).`)
		console.log(
			"   A 403 here means the GitHub App lacks the `dependabot_alerts: read` permission — " +
				"the audit cannot see advisories it is not granted, and will under-report until that is fixed.",
		)
	}
	// Exit non-zero only when the audit could not do its job at all, so a cron
	// wrapper notices. Findings are not failures: an audit that exits 1 because
	// the fleet has vulnerabilities is an audit that gets muted.
	return unreadable === results.length && results.length > 0 ? 1 : 0
}

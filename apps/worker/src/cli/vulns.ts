import { acquireWithWait, LOCK_FILE } from "../lock.ts"
import { listAllOwnedRepos } from "../ops/repoList.ts"
import { dependabotTemplateBody, runSyncHooks } from "../ops/syncHooks.ts"
import { dependabotUrl, runVulnAutofix } from "../ops/vulnAutofix.ts"
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
 * `--fix-vulns`: make the open advisories ACTIONABLE, then ACTUALLY FIX THEM.
 *
 * TWO STEPS, AND THE SECOND ONE IS WHY THIS MODE EXISTS. First the Dependabot
 * lanes are derived from each repo's own alerts, because an alert on a manifest
 * no lane names can never become a PR. Then the worker bumps the vulnerable
 * dependency itself and opens the PR (see `ops/vulnAutofix.ts`).
 *
 * WHY THE SECOND STEP WAS NEEDED. The lane work was measured as insufficient on
 * its own: 2026-11-16, 52 owned repos, 129 open alerts (126 with a published
 * patch), `automated-security-fixes` enabled and not paused everywhere, lanes in
 * place — and ZERO open Dependabot PRs. Configuration that produces no PRs is
 * not a fix, and the previous docstring here said outright that opening PRs was
 * not this mode's job. That was the gap.
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
		if (argv.includes("--lanes-only")) {
			console.log("vuln-fix: --lanes-only — lanes synced, no PRs opened.")
			return syncHooksExitCode(res.lines)
		}

		// ── STEP 2: the fix itself ──────────────────────────────────────────
		//
		// Everything above only makes an advisory POSSIBLE to fix. This is the
		// part that moves the version, pushes the branch and opens the PR, which
		// is the part the fleet was missing: lanes in place, security updates on,
		// and not one PR.
		const token = deps.fetchGhToken()
		if (!token) {
			console.error("vuln-fix: no GitHub token available — no PRs opened")
			return 1
		}
		const list = await listAllOwnedRepos(deps.api, token)
		if (list.repos.length === 0) {
			console.error(`vuln-fix: could not list any repo (HTTP ${list.ok ? 200 : list.status})`)
			return 1
		}
		// A TRUNCATED FLEET IS STATED, never implied. The listing is paged, and a
		// page that failed leaves repos with no fix and no trace of why.
		if (!list.ok) {
			console.log(
				`⚠️  vuln-fix: repo listing incomplete (HTTP ${list.status}) — ${list.repos.length} repo(s) read, the rest were NOT touched`,
			)
		}
		const fixes = await runVulnAutofix(
			{
				api: deps.api,
				run: deps.run,
				exec: deps.exec,
				workdirs: deps.workdirs,
				fetchGhToken: deps.fetchGhToken,
				dry,
				report: (line) => console.log(line),
			},
			{ token, repos: list.repos.map((r) => r.fullName) },
		)
		console.log(
			dry
				? `vuln-fix: DRY RUN — ${fixes.perRepo.filter((r) => r.fixable > 0).length} repo(s) have fixable alerts; ${fixes.manual} need a human. Nothing pushed.`
				: // `alreadyPatched` is its own number because it is not work: the
					// lockfile resolves nothing vulnerable and the alert is stale. Folding
					// it into "left for a human" is what made a closed question look like
					// a backlog.
					`vuln-fix: ${fixes.opened} PR(s) opened, ${fixes.alreadyPatched} already fixed (stale advisory), ${fixes.manual} left for a human, ${fixes.failed} failed, across ${list.repos.length} repo(s).`,
		)
		// THE PAGES TO OPEN, per repo, for whatever is still open — the fixer only
		// clears what it could apply, and an operator chasing the rest needs the
		// URL rather than a repo name to search for.
		const stillOpen = fixes.perRepo.filter((r) => r.openAlerts > 0 && !r.unreadable)
		if (stillOpen.length > 0) {
			console.log("vuln-fix: Dependabot pages still carrying open alerts:")
			for (const r of stillOpen.sort((a, b) => b.openAlerts - a.openAlerts)) {
				console.log(`   ${dependabotUrl(r.repo)}  (${r.openAlerts} open)`)
			}
		}
		// A failed fix is a failure signal; a repo with nothing to fix is not.
		return fixes.failed > 0 ? 1 : syncHooksExitCode(res.lines)
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
	// EVERY repo, not the first page of them. This used to read one page of
	// `/user/repos`, so repo 101 and beyond were never audited and the count it
	// printed looked like a complete fleet. See `ops/repoList.ts`.
	const listed = await listAllOwnedRepos(deps.api, token)
	if (listed.repos.length === 0) {
		console.error(`vuln-scan: failed to list repos (HTTP ${listed.ok ? 200 : listed.status})`)
		return 1
	}
	if (!listed.ok) {
		// The audit still runs on what it has, but says out loud that it is partial:
		// "no vulnerabilities in 100 repos" is a very different claim from "no
		// vulnerabilities in the fleet".
		console.log(
			`⚠️  vuln-scan: repo listing incomplete (HTTP ${listed.status}) — auditing ${listed.repos.length} repo(s) only`,
		)
	}
	const repos = listed.repos.map((r) => r.fullName)
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
			// The page, next to the count. A finding nobody can navigate to is a
			// finding that waits for someone to reconstruct the URL by hand.
			console.log(`   📄 ${dependabotUrl(repo)}  (${alerts.length} open)`)
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

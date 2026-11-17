// `--maintain`: the housekeeping pass that has no PR of its own.
//
// Everything here is work that used to be nobody's:
//
//   disk     — the box was at 90% with nothing pruning the worker's clones.
//   settings — four security switches per repo, checked nightly, ENFORCED here.
//   hygiene  — branches and PRs this worker opened and then abandoned.
//   triage   — red CI on its own PRs, which used to sit there silently.
//
// RETRYING FAILED QUEUE JOBS IS NOT HERE, on purpose: those rows live in the
// database the API owns, and the API's queue pump now sweeps them at boot and
// every half hour (see `db-review-queue.ts`). A CLI that reached into that table
// from a second process would be a second writer of the same state.
//
// Read-mostly by nature: every step reports what it did, and `--dry` reports what
// it would have done. It takes the worker lock so it cannot interleave with a
// tick that is mid-write on the same repos.

import { acquireWithWait, LOCK_FILE } from "../lock.ts"
import { runTriage } from "../ops/ciTriage.ts"
import { guardDisk, nodeDiskDeps } from "../ops/diskGuard.ts"
import { runHygiene } from "../ops/hygiene.ts"
import { listAllOwnedRepos } from "../ops/repoList.ts"
import { enforceRepoSettings } from "../ops/repoSettings.ts"
import { Report } from "../report.ts"
import type { WorkerCliContext } from "./context.ts"

/** Where the worker clones repos. Shared with the fixer and the pipeline. */
const WORK_BASE = process.env.PR_AGENT_WORK_DIR || "/tmp/pr-queue-work"

export async function maintain(argv: string[], context: WorkerCliContext): Promise<number> {
	const { buildDeps, setReleaseHeld } = context
	const dry = argv.includes("--dry")
	// The four steps can also be run alone, which is what a person debugging one of
	// them wants. `--maintain` runs all of them.
	const only = (flag: string): boolean => argv.includes("--maintain") || argv.includes(flag)

	const lock = await acquireWithWait(LOCK_FILE)
	if (!lock) {
		console.log("another pr-queue-worker run held the lock for 2 minutes — giving up")
		return 1
	}
	setReleaseHeld(() => lock.release())

	let failures = 0
	try {
		const deps = buildDeps({ dry, report: new Report() })
		const say = (line: string) => console.log(line)

		// ── 1. DISK ────────────────────────────────────────────────────────────
		// FIRST, because every step below clones or writes. A guard that runs after
		// the work has already failed at its job.
		const disk = guardDisk(
			nodeDiskDeps((argv2) => deps.exec(argv2, undefined, 600), say),
			{
				base: WORK_BASE,
				// A dry run still MEASURES — that is the point of asking — but must not
				// delete anything, so the reaper threshold is set out of reach.
				...(dry ? { reapAtPct: 101 } : {}),
			},
		)
		say(
			`maintenance: disk ${disk.usedPctBefore}% → ${disk.usedPctAfter}% ` +
				`(${disk.removed} workdir(s) removed${disk.pruned.length ? `, pruned ${disk.pruned.join(", ")}` : ""})`,
		)
		if (disk.refuse && !dry) {
			// The steps below all clone or write. Refusing here is the whole reason the
			// guard exists; exiting non-zero makes systemd say so out loud.
			console.error("maintenance: refusing to run — disk is too full for new work")
			return 1
		}

		// ── The fleet ──────────────────────────────────────────────────────────
		const token = deps.fetchGhToken()
		const listed = await listAllOwnedRepos(deps.api, token)
		if (!listed.ok && listed.repos.length === 0) {
			console.error(`maintenance: repo listing failed (HTTP ${listed.status}) — nothing done`)
			return 1
		}
		if (!listed.ok) {
			say(
				`⚠️  maintenance: repo listing incomplete (HTTP ${listed.status}) — ${listed.repos.length} repo(s) only`,
			)
		}
		const repos = listed.repos.map((r) => r.fullName)
		say(`maintenance: ${repos.length} repo(s)`)

		// ── 2. SETTINGS ────────────────────────────────────────────────────────
		if (only("--enforce-settings")) {
			const enforced = await enforceRepoSettings(deps.api, { repos, token, dry, log: say })
			say(
				`settings: ${enforced.converged ? "every repo in the desired state" : `${enforced.blocked.length} repo(s) could not be converged`}` +
					(enforced.unavailable.length > 0
						? `, ${enforced.unavailable.length} repo(s) do not offer secret scanning`
						: ""),
			)
			for (const line of enforced.blocked) say(`⚠️  settings: ${line}`)
			// `unavailable` is NOT a failure: a private repo without GitHub Advanced
			// Security cannot have secret scanning, and failing the unit for it would
			// fire the failure alert every six hours forever.
			if (!enforced.converged && !dry) failures += 1
		}

		// ── 3. HYGIENE ─────────────────────────────────────────────────────────
		if (only("--hygiene")) {
			const hygiene = await runHygiene({ api: deps.api, token, repos, dry, log: say })
			for (const line of hygiene.lines) say(line)
			say(`hygiene: ${hygiene.closed} PR(s) closed, ${hygiene.deleted} branch(es) deleted`)
		}

		// ── 4. CI TRIAGE ───────────────────────────────────────────────────────
		if (only("--triage")) {
			const triage = await runTriage({ api: deps.api, token, repos, dry, log: say })
			for (const line of triage.lines) say(line)
			say(`triage: ${triage.rerun} run(s) re-run, ${triage.commented} PR(s) commented`)
		}

		return failures > 0 ? 1 : 0
	} finally {
		lock.release()
		setReleaseHeld(null)
	}
}

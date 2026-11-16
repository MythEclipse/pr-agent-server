import { acquireWithWait, LOCK_FILE, WorkerLock } from "../lock.ts"
import { runSyncHooks } from "../ops/syncHooks.ts"
import { Report } from "../report.ts"
import { runUpstreamSync } from "../sync/run.ts"
import type { WorkerCliContext } from "./context.ts"

/**
 * `--sync-only <owner/fork> [--dry]` (Python lines 2209-2223): take the lock,
 * run the upstream sync for one repo, print the report, release.
 *
 * The lock refusal PRINTS and exits 1 here (Python line 2216-2217) rather than
 * returning silently as `main()` does — a human at a terminal needs to know why
 * nothing happened.
 */
export async function syncOnly(argv: string[], context: WorkerCliContext): Promise<number> {
	const { buildDeps, setReleaseHeld } = context
	const i = argv.indexOf("--sync-only")
	const next = argv[i + 1]
	const target = next && !next.startsWith("-") ? next : undefined
	const dry = argv.includes("--dry")

	const lock = WorkerLock.acquire(LOCK_FILE)
	if (!lock) {
		console.log("another pr-queue-worker run holds the lock — try again shortly")
		return 1
	}
	setReleaseHeld(() => lock.release())
	try {
		const deps = buildDeps({ dry, report: new Report() })
		const report = await runUpstreamSync(
			{
				run: deps.run,
				workdirs: deps.workdirs,
				agent: deps.agent,
				api: deps.api,
				fetchGhToken: deps.fetchGhToken,
				postDiscord: deps.postDiscord,
				loadState: deps.loadSyncState,
				saveState: deps.saveSyncState,
				now: deps.now,
				report: deps.report,
				repoOverrides: deps.repoOverrides,
			},
			{ only: target, dry },
		)
		console.log(report.length ? report.join("\n") : "(nothing to sync)")
	} finally {
		lock.release()
		setReleaseHeld(null)
	}
	return 0
}

/**
 * Exit code for a `--sync-hooks` run.
 *
 * EXIT 1 MEANS "SOMETHING FAILED", NOT "NOTHING CHANGED". The previous rule was
 * `ok > 0 || skip === 0`, so a run where every repo was already in sync — the
 * steady state, and the overwhelmingly common outcome — returned 1 and systemd
 * marked the unit `failed`. Measured on the box: a clean 62-repo run reporting
 * "0 updated, 434 skipped" landed as `Result: exit-code`, indistinguishable from
 * the gate refusal that had actually been breaking this job for three nights. A
 * monitor that cannot tell "nothing to do" from "broken" is worse than none.
 *
 * `skip` counts every step that needed no change, so it is not a failure signal
 * at all. The only failure signal the summary carries is a line the module emits
 * with the ⚠️ prefix — `runSyncHooks` turns a thrown error and every per-repo
 * failure into exactly one of those.
 *
 * Exported for the test: the decision is the whole point, and reaching it
 * through `syncHooks()` would need a fully stubbed GitHub client.
 */
export function syncHooksExitCode(lines: readonly string[]): number {
	return lines.some((line) => line.startsWith("⚠️")) ? 1 : 0
}

/**
 * `--sync-hooks` (Task 16): the daily fork-config sync — the pr-agent webhook
 * plus the three Dependabot files, across every repo the token can see.
 *
 * A SEPARATE CLI MODE, not a step inside the tick, and that placement is the
 * point. The tick runs every five minutes; this writes fleet-wide config, and
 * the Dependabot templates were authored from scratch during the migration with
 * no surviving record of the previous fleet config. Firing that on a five-minute
 * cadence would mean the first accidental run rewrites every fork at once. A
 * daily mode is something a scheduler can be pointed at deliberately.
 *
 * It takes the same lock the tick takes, so the two cannot interleave and
 * half-apply a fleet.
 */
export async function syncHooks(argv: string[], context: WorkerCliContext): Promise<number> {
	const { buildDeps, webhookSecret, setReleaseHeld } = context
	// WAIT, do not fail. A nightly run that dies because a 36-second tick happened
	// to be in flight is reported as `Result: exit-code` — the same signal as a
	// real failure, and this job was just dug out of exactly that noise. See
	// `acquireWithWait`.
	const lock = await acquireWithWait(LOCK_FILE)
	if (!lock) {
		console.log("another pr-queue-worker run held the lock for 2 minutes — giving up")
		return 1
	}
	setReleaseHeld(() => lock.release())
	try {
		const deps = buildDeps({ dry: argv.includes("--dry"), report: new Report() })
		const res = await runSyncHooks({
			api: deps.api,
			// The PAT push path is a different credential from the App's JWT; the ops
			// module asks the client for it, exactly as the Python's
			// `_fetch_gh_token()` did.
			ghToken: deps.fetchGhToken(),
			webhookSecret,
			syncSecurity: true,
			// `--dry` is FORWARDED, and it must be. It used to be passed only to
			// `buildDeps`, which is where the TICK reads it; this module ignored
			// it, so `--sync-hooks --dry` performed the fleet-wide writes it was
			// asked to preview. Measured on the box: a dry run rewrote
			// `.github/dependabot.yml` across every repo.
			dry: argv.includes("--dry"),
		})
		for (const line of res.lines) console.log(line)
		// A PREVIEW MUST NOT SAY "UPDATED". Dry runs report their suppressed
		// writes as `ok`, so the summary read "124 updated, 310 skipped" for a
		// run that changed nothing at all — the same class of lie as the write
		// itself. The counts are still useful, so they stay; only the verb
		// changes, and a dry run is named as one.
		const dry = argv.includes("--dry")
		console.log(
			dry
				? `sync-hooks: DRY RUN — ${res.ok} would change, ${res.skip} already correct (nothing written)`
				: `sync-hooks: ${res.ok} updated, ${res.skip} skipped`,
		)
		const code = syncHooksExitCode(res.lines)
		if (code !== 0) {
			console.error(
				`sync-hooks: ${res.lines.filter((l) => l.startsWith("⚠️")).length} step(s) reported an error`,
			)
		}
		return code
	} finally {
		lock.release()
		setReleaseHeld(null)
	}
}

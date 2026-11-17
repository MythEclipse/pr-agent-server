// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code; GitHub payloads are untyped JSON
// biome-ignore-all lint/style/noNonNullAssertion: test helper asserts immediately after
/**
 * CI verification and auto-revert — port of `scripts/pr-queue-worker.py`
 * lines 1451-1517 (`verify_pending_syncs`), the caller of `_sync_revert_merge`
 * (1427-1450).
 *
 * THE FEATURE: the worker pushes merge commits DIRECTLY to fork default
 * branches, so a red main is a red main. This watch reverts our own merge when
 * the fork's CI fails AT THAT COMMIT — but only while that commit is still the
 * tip. Once a human (or another sync) pushes on top, the merge is no longer
 * ours to undo and the watch simply stops.
 *
 * Unreadable tips or CI lists keep the watch armed until a later tick. Only a
 * confirmed successful rollback clears the merge record. A rollback also uses
 * an explicit Git lease so a push after the tip read cannot be overwritten.
 */
import { listCheckRuns } from "../pr/ci.ts"
import type { GhClient } from "../pr/scan.ts"
import type { RepoOverrides, SyncEntry, SyncState } from "./config.ts"
import { num, pendingVerify, syncConfig } from "./config.ts"
import type { RevertArgs, RevertOutcome } from "./merge.ts"
import type { PostDiscord } from "./run.ts"

/** Python `failed[:3]` (line 1489) — a cap on a report, not a filter. */
const NAME_CAP = 3

/** The red-side colour from Python line 1497. */
const REVERT_COLOR = 0xe74c3c

/** Python's `revert_merge(...)` call, as a seam. */
export type RevertPort = (args: RevertArgs) => Promise<RevertOutcome>

/** Everything `verifyPendingSyncs` needs from the world. */
export type VerifyDeps = {
	api: GhClient
	/**
	 * The per-fork `enabled` flag, from `PR_AGENT_UPSTREAM_SYNC` at call time.
	 *
	 * A bare boolean rather than a whole `SyncConfig`: the watch resolves each
	 * fork's config itself through `syncConfig(fork, repoOverrides, enabled)`, so
	 * a `baseConfig` here would be read for `enabled` and ignored for everything
	 * else — a field that looks load-bearing and is not. A `verify_ci: false`
	 * override belongs in `repoOverrides`, which is what the Python's
	 * `UPSTREAM_SYNC["repos"]` is.
	 */
	enabled: boolean
	/** Per-repo overrides, layered over the worker defaults per fork. */
	repoOverrides: RepoOverrides
	/** Python `time.time()` (line 1469). */
	now: () => number
	/** Python `save_sync_state` (state.ts), swappable for a test. */
	saveState: (state: SyncState) => void
	/** Python `_sync_revert_merge` (merge.ts), swappable for a test. */
	revertMerge: RevertPort
	postDiscord: PostDiscord
}

/** The Python's `get_installation_token`-free token map: `{fork: token}`. */
export type TokenByRepo = Record<string, string>

const asObject = (value: unknown): Record<string, any> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, any>)
		: undefined

/**
 * Python `verify_pending_syncs(state, token_by_repo, dry=False)` (lines
 * 1451-1517): "CI-verify merges we pushed directly. … Returns report lines."
 *
 * NEVER THROWS beyond what a caller must handle: `GhClient.request` already
 * never throws (github.ts exhausts its retries and returns `{status: 0,
 * data: {}}`). An unavailable tip or incomplete CI list keeps the watch armed.
 *
 * The `pending_verify` sha is the guard, not the branch name: a merge we did
 * not push has no `pending_verify`, so it is never a candidate for a revert.
 */
export async function verifyPendingSyncs(
	deps: VerifyDeps,
	state: SyncState,
	tokenByRepo: TokenByRepo,
	dry = false,
): Promise<string[]> {
	const lines: string[] = []

	for (const fork of Object.keys(state)) {
		const entry = state[fork] as SyncEntry
		const pending = pendingVerify(entry)
		// Python lines 1458-1459: no sha means no watch.
		if (!pending?.sha) continue
		const token = tokenByRepo[fork] || "" // Python line 1461
		if (!token) continue // Python line 1462
		const cfg = syncConfig(fork, deps.repoOverrides, deps.enabled)
		const branch = pending.branch || "main" // Python line 1465

		// (a) — clears in memory, deliberately does NOT save and does NOT report.
		if (!cfg.verify_ci || dry) {
			entry.pending_verify = null
			continue
		}

		const age = deps.now() - num(pending.pushed_at) // Python line 1469

		// (b) — the merge is KEPT; only the watch stops.
		if (age > cfg.verify_ci_max_age_h * 3600) {
			lines.push(
				`   ⌛ ${fork}: merge ${pending.sha.slice(0, 8)} unverified for ` +
					`${(age / 3600).toFixed(1)}h — keeping it, stopping the watch`,
			)
			entry.pending_verify = null
			deps.saveState(state)
			continue
		}

		const tipResult = await deps.api.request(
			"GET",
			`/repos/${fork}/commits/${encodeURIComponent(branch)}`,
			{ token },
		)
		const tip = asObject(tipResult.data)?.sha
		if (tipResult.status !== 200 || typeof tip !== "string" || !tip) {
			lines.push(`   ⏳ ${fork}: branch tip unavailable — keeping the CI watch`)
			continue
		}

		// (c) — someone pushed on top of our merge. Not ours to revert.
		if (tip && tip !== pending.sha) {
			lines.push(
				`   ✓ ${fork}: ${branch} moved past our merge ` +
					`(${pending.sha.slice(0, 8)} → ${tip.slice(0, 8)}) — nothing to verify`,
			)
			entry.pending_verify = null
			deps.saveState(state)
			continue
		}

		const {
			status,
			runs: checks,
			complete,
		} = await listCheckRuns(deps.api, token, fork, pending.sha)
		if (status !== 200 || !complete) {
			lines.push(`   ⏳ ${fork}: CI list unavailable or incomplete — keeping the CI watch`)
			continue
		}
		const failed = checks.filter(
			(c: any) =>
				c?.status === "completed" && !["success", "neutral", "skipped"].includes(c?.conclusion),
		)
		const running = checks.filter((c: any) => c?.status !== "completed")

		// (d) — the only path that touches the branch.
		if (failed.length) {
			const names = failed
				.slice(0, NAME_CAP)
				.map((c: any) => (typeof c?.name === "string" ? c.name : "?"))
				.join(", ")
			const reverted = await deps.revertMerge({
				appToken: token,
				fork,
				branch,
				preMergeSha: pending.pre_merge_sha ?? "",
				expectedHeadSha: pending.sha,
				reason: `CI failed: ${names}`,
			})
			if (!reverted.ok) {
				lines.push(`   ⚠️ ${fork}: rollback failed: ${reverted.detail} — keeping the CI watch`)
				continue
			}
			lines.push(`   ↩️  ${fork}: ${reverted.detail}`)
			await deps.postDiscord(
				`↩️ Fork sync reverted: ${fork}`,
				[
					`CI failed at our merge commit \`${pending.sha.slice(0, 8)}\` (${names}).`,
					reverted.detail,
					`https://github.com/${fork}/commits/${branch}`,
				],
				REVERT_COLOR,
			)
			entry.pending_verify = null
			// Python line 1500: forgetting the merged sha is what makes the NEXT
			// tick retry this upstream tip instead of skipping it as handled.
			entry.last_merged_upstream_sha = ""
			deps.saveState(state)
			continue
		}

		// (e) — no checks and still young. Do nothing at all, and do not save:
		// the check-runs may simply not have registered yet. The comparison is
		// `age < grace` (EXCLUSIVE), so exactly `grace` seconds old stops the watch.
		if (!checks.length) {
			if (age < cfg.no_ci_grace_s) continue
			entry.pending_verify = null
			deps.saveState(state)
			continue
		}

		// (g) — still running; verify on a later tick.
		if (running.length) continue

		// (h) — green.
		lines.push(
			`   ✅ ${fork}: merge ${pending.sha.slice(0, 8)} verified green ` +
				`(${checks.length} check(s))`,
		)
		entry.pending_verify = null
		deps.saveState(state)
	}

	return lines
}

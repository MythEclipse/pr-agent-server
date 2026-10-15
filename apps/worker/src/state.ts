/**
 * Fix-state / sync-state JSON — port of `scripts/pr-queue-worker.py`
 * lines 236-298 (fix state) and 1006-1022 (sync state).
 *
 * CUT-OVER CONTRACT (Task 17): these files survive the Python→TS switch, so the
 * on-disk format must stay parseable by the Python reader. Two files, two
 * different serializers — deliberately NOT unified:
 *   - fix state  → `JSON.stringify(state)`, compact, no indent (Python line 249)
 *   - sync state → `JSON.stringify(state, null, 1)`, indent=1 (Python line 1020)
 * Repo keys are full `owner/repo` names; PR keys are STRINGIFIED numbers.
 *
 * Note: JSON.parse/JSON.stringify omit the `": "` separator spaces Python's
 * `json.dumps` emits, so the fix-state bytes are not identical — they are
 * PARSE-equivalent, which is what the Python reader needs. The sync state
 * (indent=1) matches the live file byte-for-byte.
 *
 * SAVE SEMANTICS: the Python mutators (`mark_fixed`, `mark_skip`,
 * `mark_skip_notified`) persist as a side effect, so a caller that forgets to
 * save re-fixes the same PR every tick. Here each mutator takes an OPTIONAL
 * `file`: pass it and the write happens for you (Python parity); omit it and
 * the mutation stays in memory (which is what the unit tests do, so they
 * never touch the production state path). Prefer passing the file.
 */
import { readFileSync, writeFileSync } from "node:fs"

/** Python `FIX_STATE_FILE` (line 66) — the canonical path for `saveFixState`. */
export const FIX_STATE_FILE = "/tmp/pr-queue-fix-state.json"
/** Python `SYNC_STATE_FILE` (line 985). */
export const SYNC_STATE_FILE = "/tmp/pr-queue-sync-state.json"

/** Per-PR record. `skip_reason` is absent (not null) when there is no skip. */
export interface PrEntry {
	sha?: string
	skip_reason?: string
	notified?: boolean
	/**
	 * Consecutive failed attempts at `sha`, cleared by `markFixed`/`markSkip`.
	 *
	 * THE ATTEMPT TALLY. `skip_reason` only ever got set for `[INFRA]` failures
	 * (CLI missing, timeout, gateway down). An ORDINARY failure recorded nothing
	 * at all, so the next tick saw a PR with no state, concluded it was untried,
	 * and paid for the identical work again. GMW#109 sat that way for days:
	 * `🔴 SAFETY BLOCKED (score: 0/10)` every five minutes, and neither the block
	 * nor the "agent ran but no commit" line below it left a single byte behind.
	 *
	 * It is a DIAGNOSTIC, NOT A DEADLINE. An earlier version capped it with
	 * `MAX_ATTEMPTS` and pinned the PR past the cap, which was wrong — a PR that
	 * cannot be fixed must keep being retried, not be written off, and pinning it
	 * is a permanent stall rather than an escalation. Nothing reads this to
	 * decide whether to give up; it exists so the report can say "attempt 47" and
	 * so a human can see at a glance that a PR is stuck rather than merely slow.
	 *
	 * Counted from scratch whenever the head SHA moves, because a new head is
	 * new work and must not inherit the previous head's tally.
	 */
	attempts?: number
	/**
	 * The head the `attempts` tally belongs to. SEPARATE from `sha` on purpose:
	 * `sha` is what `alreadyFixed` reads as "fixed here", so keying the tally off
	 * it made a recorded failure indistinguishable from a recorded success and
	 * suppressed every retry. See `bumpAttempt`.
	 */
	attempt_sha?: string
	[key: string]: unknown
}

/**
 * Record a failed attempt at `headSha` and return the running count.
 *
 * Idempotent per SHA: calling it for a different head resets to 1, because the
 * previous head's failures say nothing about this one. Only ever increments
 * when the SHA still matches, so a PR that moved does not inherit a stale
 * tally.
 *
 * NO CEILING. There is deliberately no maximum and no "give up" behaviour here
 * or anywhere that reads this number — see the `attempts` field's doc comment.
 *
 * WHY IT NO LONGER TOUCHES `entry.sha`. `bumpAttempt` used to set `sha` so the
 * tally would reset when the head moved. But `sha` is the SAME field
 * `alreadyFixed` reads as "the fix succeeded at this head", so recording a
 * failure silently marked the PR as DONE — `stepAiFix` then hit
 * `⏭️  Already fixed at this SHA` and the agent was never asked again. That is
 * the exact failure this worker exists to prevent, and it is unreachable to
 * notice from a report, because every line of it looks like success. The tally
 * is now keyed on its own `attempt_sha`, so a failed attempt stays a failed
 * attempt and only `markFixed` may claim a head.
 */
export function bumpAttempt(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number {
	const entry = prEntry(state, repo, pr)
	const prior = entry.attempt_sha === headSha ? Number(entry.attempts ?? 0) : 0
	const next = (Number.isFinite(prior) ? prior : 0) + 1
	entry.attempt_sha = headSha
	entry.attempts = next
	return next
}

/** The attempt count for `headSha`, or 0 if this head was never tried. */
export function attemptCount(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): number {
	const entry = prEntry(state, repo, pr)
	// Keyed on `attempt_sha`, not `sha` — see `bumpAttempt`. Reading `sha` here
	// would count a SUCCESS as a tally of failures.
	if (entry.attempt_sha !== headSha) return 0
	const n = Number(entry.attempts ?? 0)
	return Number.isFinite(n) ? n : 0
}

/** `{ "owner/repo": { "<pr>": PrEntry } }` */
export type FixState = Record<string, Record<string, PrEntry>>

/**
 * Sync bookkeeping per fork. The field set belongs to the sync task, which is
 * not ported yet, so the entry stays opaque rather than speculative.
 */
export type SyncState = Record<string, Record<string, unknown>>

/** Read a JSON file, falling back when it is missing, unreadable or corrupt. */
function readJsonTolerant<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T
	} catch {
		return fallback
	}
}

export function loadFixState(file: string = FIX_STATE_FILE): FixState {
	return readJsonTolerant<FixState>(file, {})
}

/** Compact, no indent — byte-compatible with Python's `json.dumps(state)`. */
export function saveFixState(file: string, state: FixState): void {
	writeFileSync(file, JSON.stringify(state))
}

export function loadSyncState(file: string = SYNC_STATE_FILE): SyncState {
	return readJsonTolerant<SyncState>(file, {})
}

/** indent=1, mirroring Python's `json.dumps(state, indent=1)`. OSError is swallowed. */
export function saveSyncState(file: string, state: SyncState): void {
	try {
		writeFileSync(file, JSON.stringify(state, null, 1))
	} catch {
		/* Python: `except OSError: pass` */
	}
}

/**
 * Get the per-PR entry, creating it if absent, and migrate the legacy format
 * `{repo: {pr: "sha"}}` (bare string) to the dict form IN PLACE. Python
 * `_pr_entry`, lines 251-259.
 */
export function prEntry(state: FixState, repo: string, pr: number | string): PrEntry {
	// Spelled as two statements rather than `?? (state[repo] = {})`: an
	// assignment nested in an expression reads as a typo at a glance.
	if (state[repo] === undefined) state[repo] = {}
	const repoState = state[repo] as Record<string, unknown>
	const key = String(pr)
	const existing = repoState[key]
	if (typeof existing === "string") {
		// legacy: {"pr": "sha"} → {"sha": "sha", "notified": false} (no skip_reason)
		repoState[key] = { sha: existing, notified: false }
	} else if (existing === undefined) {
		repoState[key] = {}
	}
	return repoState[key] as PrEntry
}

/** True if this PR was already fixed (or permanently skipped) at this SHA. */
export function alreadyFixed(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): boolean {
	return prEntry(state, repo, pr).sha === headSha
}

/** Mark the PR as fixed at `headSha`. Pass `file` to persist (Python parity). */
export function markFixed(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
	file?: string,
): PrEntry {
	const entry = prEntry(state, repo, pr)
	entry.sha = headSha
	delete entry.skip_reason
	entry.notified = false
	// Success resets the tally: the next failure at this SHA starts from 1, not
	// from wherever a previous run left it. Without this a PR that fails once,
	// succeeds, then fails again would skip straight to escalation.
	delete entry.attempts
	delete entry.attempt_sha
	if (file !== undefined) saveFixState(file, state)
	return entry
}

/** The permanent skip reason for this PR+SHA, or undefined for any other SHA. */
export function getSkipReason(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): string | undefined {
	const entry = prEntry(state, repo, pr)
	return entry.sha === headSha ? entry.skip_reason : undefined
}

/** Permanently skip AI-fix/merge for this PR at this SHA. Pass `file` to persist. */
export function markSkip(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
	reason: string,
	file?: string,
): PrEntry {
	const entry = prEntry(state, repo, pr)
	entry.sha = headSha
	entry.skip_reason = reason
	// A skip RESOLVES the condition, so the tally goes with it. Leaving it
	// behind would mean that if the skip were ever cleared by hand, the very next
	// failure would escalate straight back to a pin with no fresh attempts.
	delete entry.attempts
	delete entry.attempt_sha
	if (file !== undefined) saveFixState(file, state)
	return entry
}

/** True if the skip notification for this PR+SHA was already sent. */
export function wasSkipNotified(
	state: FixState,
	repo: string,
	pr: number | string,
	headSha: string,
): boolean {
	const entry = prEntry(state, repo, pr)
	return Boolean(entry.notified) && entry.sha === headSha
}

/** Record that the skip notification went out. Pass `file` to persist. */
export function markSkipNotified(
	state: FixState,
	repo: string,
	pr: number | string,
	// Kept for call-site symmetry with markFixed/markSkip; the Python signature
	// carries the head sha here and the port preserved it.
	_headSha: string,
	file?: string,
): PrEntry {
	const entry = prEntry(state, repo, pr)
	entry.notified = true
	if (file !== undefined) saveFixState(file, state)
	return entry
}

// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code / test fixtures use untyped JSON shapes
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
	alreadyFixed,
	attemptCount,
	bumpAttempt,
	bumpConflictRun,
	conflictRunCount,
	type FixState,
	getSkipReason,
	loadFixState,
	markFixed,
	markRebaseStep,
	markSkip,
	markSkipNotified,
	prEntry,
	rebaseStepAt,
	wasSkipNotified,
} from "../src/state.ts"

// ── The conflict tally — the BotWa#29/#27 deadlock ──────────────────────────
//
// A conflict run that pushes nothing must never be recorded as a FIX. It used
// to be: `runAiFix` returns `ok: true` for a clean tree, the resolver read that
// as "resolved", and `markFixed` pinned the head. Since a no-op run moves no
// head, `alreadyFixed` then answered TRUE forever and the agent was never
// offered again. These tests pin the replacement: a separate tally keyed on its
// own sha, so a failure can never masquerade as a success.
describe("conflict tally — a no-push run is counted, never claimed as a fix", () => {
	const REPO = "MythEclipse/BotWa"
	const PR = 29
	const SHA = "ba83a599c79e7f7f3bf1937879c2d5a541a8474c"

	test("counts no-push runs at one head", () => {
		const s = {}
		expect(conflictRunCount(s, REPO, PR, SHA)).toBe(0)
		expect(bumpConflictRun(s, REPO, PR, SHA)).toBe(1)
		expect(bumpConflictRun(s, REPO, PR, SHA)).toBe(2)
		expect(conflictRunCount(s, REPO, PR, SHA)).toBe(2)
	})

	test("it does NOT set `sha`, so `alreadyFixed` stays false", () => {
		// THE WHOLE BUG IN ONE ASSERTION. If this ever becomes true, the agent is
		// locked out of a head that no no-op run can move — the BotWa deadlock.
		const s = {}
		bumpConflictRun(s, REPO, PR, SHA)
		expect(alreadyFixed(s, REPO, PR, SHA)).toBe(false)
		expect(prEntry(s, REPO, PR).sha).toBeUndefined()
	})

	test("a new head resets the tally", () => {
		const s = {}
		bumpConflictRun(s, REPO, PR, SHA)
		bumpConflictRun(s, REPO, PR, SHA)
		expect(bumpConflictRun(s, REPO, PR, "bbbb2222")).toBe(1)
		expect(conflictRunCount(s, REPO, PR, SHA)).toBe(0)
		expect(conflictRunCount(s, REPO, PR, "bbbb2222")).toBe(1)
	})

	test("a landed fix clears it, so a later conflict starts fresh", () => {
		const s = {}
		bumpConflictRun(s, REPO, PR, SHA)
		markFixed(s, REPO, PR, "cccc3333", 2)
		expect(conflictRunCount(s, REPO, PR, "cccc3333")).toBe(0)
	})

	test("a skip clears it too", () => {
		const s = {}
		bumpConflictRun(s, REPO, PR, SHA)
		markSkip(s, REPO, PR, SHA, "gone: merge returned 404 (Not Found)")
		expect(conflictRunCount(s, REPO, PR, SHA)).toBe(0)
	})
})

describe("attempt tally — a diagnostic, never a deadline", () => {
	const REPO = "asepharyana/GMW"
	const PR = 109
	const SHA = "aaaa1111"

	test("counts consecutive failures at the same head", () => {
		const s = {}
		expect(bumpAttempt(s, REPO, PR, SHA)).toBe(1)
		expect(bumpAttempt(s, REPO, PR, SHA)).toBe(2)
		expect(bumpAttempt(s, REPO, PR, SHA)).toBe(3)
		expect(attemptCount(s, REPO, PR, SHA)).toBe(3)
	})

	test("the count is unbounded — a stuck PR keeps being retried", () => {
		// The policy an earlier version got wrong. There is deliberately no
		// ceiling: nothing may read this number to decide a PR is hopeless,
		// because writing it off is a permanent stall, not an escalation. A PR
		// that cannot be fixed must stay in the queue and be retried until it
		// can, or until a human sees "attempt 47" and intervenes.
		const s = {}
		for (let i = 0; i < 50; i++) bumpAttempt(s, REPO, PR, SHA)
		expect(attemptCount(s, REPO, PR, SHA)).toBe(50)
		// And no skip_reason was invented along the way.
		expect(prEntry(s, REPO, PR).skip_reason).toBeUndefined()
	})

	test("a new head starts from 1 — new work is not a continuation", () => {
		const s = {}
		bumpAttempt(s, REPO, PR, SHA)
		bumpAttempt(s, REPO, PR, SHA)
		// The head moved, so the previous head's failures say nothing about this
		// one. Carrying the tally over would escalate a PR that is now genuinely
		// being fixed.
		expect(bumpAttempt(s, REPO, PR, "bbbb2222")).toBe(1)
		expect(attemptCount(s, REPO, PR, "bbbb2222")).toBe(1)
		// And the old head reads as untried again.
		expect(attemptCount(s, REPO, PR, SHA)).toBe(0)
	})

	test("success clears the tally", () => {
		// The reset that keeps "fail, succeed, fail" from skipping straight to
		// escalation.
		const s = {}
		bumpAttempt(s, REPO, PR, SHA)
		bumpAttempt(s, REPO, PR, SHA)
		markFixed(s, REPO, PR, SHA)
		expect(attemptCount(s, REPO, PR, SHA)).toBe(0)
		expect(bumpAttempt(s, REPO, PR, SHA)).toBe(1)
	})

	test("a skip clears the tally too", () => {
		const s = {}
		bumpAttempt(s, REPO, PR, SHA)
		markSkip(s, REPO, PR, SHA, "Unresolvable: safety gate")
		expect(attemptCount(s, REPO, PR, SHA)).toBe(0)
	})

	test("a corrupt attempts value cannot poison the count", () => {
		// The state file is hand-editable and survives across a Python/TS cutover,
		// so `attempts` can arrive as anything at runtime even though the type
		// says `number`. A NaN here would make every comparison false and the
		// guard would silently never fire — the worst possible failure for a
		// safety mechanism, so it is cast through `as unknown` deliberately to
		// reproduce the untrusted input the state file really is.
		const s = {
			[REPO]: { [String(PR)]: { sha: SHA, attempts: "not a number" } },
		} as unknown as FixState
		// Reading it is finite and treated as zero…
		expect(attemptCount(s, REPO, PR, SHA)).toBe(0)
		// …and the NEXT increment starts from that zero, not from NaN. A NaN tally
		// would be silently swallowed: `NaN + 1` is NaN, so the count would stay
		// NaN forever and the report would read "attempt NaN" — losing the one
		// signal a human uses to see that a PR is stuck.
		expect(bumpAttempt(s, REPO, PR, SHA)).toBe(1)
	})
})

describe("fix state", () => {
	test("missing file loads the empty shape", () => {
		expect(loadFixState(join(mkdtempSync(join(tmpdir(), "st-")), "none.json"))).toEqual({})
	})
	test("corrupt file loads the empty shape instead of throwing", () => {
		const f = join(mkdtempSync(join(tmpdir(), "st-")), "bad.json")
		writeFileSync(f, "{not json")
		expect(loadFixState(f)).toEqual({})
	})
	test("migrates the legacy bare-string entry", () => {
		const s: any = { "o/r": { "1": "abc123" } }
		prEntry(s, "o/r", 1)
		expect(s["o/r"]["1"].sha).toBe("abc123")
		expect(s["o/r"]["1"].notified).toBe(false)
	})
	test("skip reason is per head sha and notified once", () => {
		const s: any = {}
		markSkip(s, "o/r", 1, "sha1", "infra down")
		expect(getSkipReason(s, "o/r", 1, "sha1")).toBe("infra down")
		expect(getSkipReason(s, "o/r", 1, "sha2")).toBeFalsy()
		expect(wasSkipNotified(s, "o/r", 1, "sha1")).toBe(false)
		markSkipNotified(s, "o/r", 1, "sha1")
		expect(wasSkipNotified(s, "o/r", 1, "sha1")).toBe(true)
	})
	test("a skip at a NEW head re-arms the notification", () => {
		// `wasSkipNotified` is `notified && sha === headSha`. Writing the new head
		// while leaving `notified` set from the OLD one made the pair agree on the
		// new SHA, so `notifySkipOnce` short-circuited and the operator was never
		// told this head had been skipped — the exact silent loss the per-head key
		// exists to avoid.
		const s: any = {}
		markSkip(s, "o/r", 1, "sha1", "infra down")
		markSkipNotified(s, "o/r", 1, "sha1")
		expect(wasSkipNotified(s, "o/r", 1, "sha1")).toBe(true)
		// A different head is a different event and must be announced.
		markSkip(s, "o/r", 1, "sha2", "infra down again")
		expect(wasSkipNotified(s, "o/r", 1, "sha2")).toBe(false)
	})

	test("re-recording the SAME skip does not re-arm the notification", () => {
		// A retried write, or a resolver that fails twice in one tick, must not
		// post to the channel again: the notice is per head, and the head did not
		// move.
		const s: any = {}
		markSkip(s, "o/r", 1, "sha1", "infra down")
		markSkipNotified(s, "o/r", 1, "sha1")
		markSkip(s, "o/r", 1, "sha1", "infra down")
		expect(wasSkipNotified(s, "o/r", 1, "sha1")).toBe(true)
	})

	test("markFixed records the head sha", () => {
		const s: any = {}
		markFixed(s, "o/r", 1, "sha9")
		expect(alreadyFixed(s, "o/r", 1, "sha9")).toBe(true)
		expect(alreadyFixed(s, "o/r", 1, "other")).toBe(false)
	})

	// The ladder record is keyed on the SHA for a reason worth pinning: a successful
	// rebase MOVES the head, so the record releases itself and the next tick
	// examines the PR again. Anything else would either repeat the comment every
	// five minutes or block the PR after one successful request.
	test("a rebase rung is recorded per head and releases on a new head", () => {
		const s: any = {}
		expect(rebaseStepAt(s, "o/r", 1, "sha1")).toBeUndefined()
		markRebaseStep(s, "o/r", 1, "sha1", "rebase")
		expect(rebaseStepAt(s, "o/r", 1, "sha1")).toBe("rebase")
		// A new head (the rebase landed) is a fresh ladder.
		expect(rebaseStepAt(s, "o/r", 1, "sha2")).toBeUndefined()
	})

	// The rung is what lets the next tick ESCALATE at the same head instead of
	// repeating a rung Dependabot already answered as a no-op.
	test("the rung advances at the same head", () => {
		const s: any = {}
		markRebaseStep(s, "o/r", 1, "sha1", "rebase")
		expect(rebaseStepAt(s, "o/r", 1, "sha1")).toBe("rebase")
		markRebaseStep(s, "o/r", 1, "sha1", "recreate")
		expect(rebaseStepAt(s, "o/r", 1, "sha1")).toBe("recreate")
	})

	// It must NOT double as a skip: the PR is waiting, not broken, and a
	// skip_reason would pin it until the head moves — the exact stall this
	// record exists to avoid.
	test("a rebase rung records no skip reason", () => {
		const s: any = {}
		markRebaseStep(s, "o/r", 1, "sha1", "rebase")
		expect(getSkipReason(s, "o/r", 1, "sha1")).toBeUndefined()
		expect(alreadyFixed(s, "o/r", 1, "sha1")).toBe(false)
	})
})

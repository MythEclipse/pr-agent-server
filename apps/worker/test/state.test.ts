// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code / test fixtures use untyped JSON shapes
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
	alreadyFixed,
	attemptCount,
	bumpAttempt,
	type FixState,
	getSkipReason,
	loadFixState,
	markFixed,
	markSkip,
	markSkipNotified,
	prEntry,
	wasSkipNotified,
} from "../src/state.ts"

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
	test("markFixed records the head sha", () => {
		const s: any = {}
		markFixed(s, "o/r", 1, "sha9")
		expect(alreadyFixed(s, "o/r", 1, "sha9")).toBe(true)
		expect(alreadyFixed(s, "o/r", 1, "other")).toBe(false)
	})
})

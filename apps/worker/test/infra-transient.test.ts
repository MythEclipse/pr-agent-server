// REGRESSION: a TRANSIENT upstream rejection must not become a permanent skip.
//
// A 403 FreeTierError from the model gateway reached the worker's agent runner
// and exited 1. `claude-agent.ts` correctly wrapped it as `[INFRA] ...`, but
// `stepAiFix` classified EVERY `[INFRA]` failure as permanent and wrote it into
// `skip_reason`, so hub#46 and pr-agent-server#5 were pinned "until head SHA
// changes" — a SHA nobody would ever move, because the fix is a credential or
// quota issue, not a code change. Two PRs sat dead with a healthy agent behind
// them, and nothing in the report distinguished "the CLI is missing" (genuinely
// permanent) from "the gateway refused this one request" (transient).
//
// The distinction is made where the prefix is read, not where it is written:
// `[INFRA]` stays the transport-level marker for "the agent run did not
// complete", and a new `isTransientInfra` splits the two by the failure's own
// evidence (a 4xx/5xx status, a quota or rate-limit shape, a network error).
import { describe, expect, test } from "vitest"

import { isBudgetExhaustion, isInfra, isTransientInfra, stripInfra } from "../src/pr/context.ts"

describe("isInfra vs isTransientInfra", () => {
	// The exact text the report showed, trimmed to the shape the CLI emits.
	const FREE_TIER_403 =
		'[INFRA] Claude Code exited 1: Failed to authenticate. API Error: 403 [403]: {"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}}'

	test("a 403 FreeTierError is INFRA but NOT permanent", () => {
		expect(isInfra(FREE_TIER_403)).toBe(true)
		// The whole point: this must NOT be recorded as skip_reason, or the PR is
		// pinned until a head SHA that will never move.
		expect(isTransientInfra(FREE_TIER_403)).toBe(true)
	})

	test.each([
		["rate limited", "[INFRA] Claude Code exited 1: API Error: 429 rate_limit_error"],
		["quota exhausted", "[INFRA] Claude Code exited 1: 402 insufficient credits"],
		["upstream 5xx", "[INFRA] Claude Code exited 1: API Error: 529 overloaded"],
		["overloaded", "[INFRA] Claude Code exited 1: overloaded_error"],
		["connection refused", "[INFRA] failed to launch /usr/local/bin/claude: ECONNREFUSED"],
		["socket hang up", "[INFRA] Claude Code exited 1: socket hang up"],
		["DNS failure", "[INFRA] Claude Code exited 1: getaddrinfo ENOTFOUND"],
	])("transient: %s", (_label, msg) => {
		expect(isTransientInfra(msg)).toBe(true)
	})

	// A 1800s agent timeout is INFRA and is now RETRYABLE, which is the reverse
	// of what this test used to assert. The old reading — "pin it so the queue
	// does not pay another 30-minute run every 5 minutes" — named a real cost but
	// chose the wrong remedy: a `skip_reason` is enforced "until head SHA
	// changes", and a timeout is a property of one RUN, not of the branch, so
	// nothing about it ever moves a head. hub#61 and pr-agent-server#27 became
	// `Permanently skipped` that way, on a bump no edit could fix.
	//
	// The cost is now bounded where it belongs: `AI_FIX_BUDGET_CEILING` counts
	// budget-exhausting runs and stops OFFERING the agent past the ceiling. So
	// the contract is "retryable, then stop spending", not "never retry".
	test("a 1800s agent timeout is retryable (it must not pin the PR)", () => {
		const timeout = "[INFRA] Claude Code timed out after 1800s"
		expect(isInfra(timeout)).toBe(true)
		expect(isTransientInfra(timeout)).toBe(true)
		// ...and it is a BUDGET exhaustion, which is what gives it a ceiling.
		expect(isBudgetExhaustion(timeout)).toBe(true)
	})

	test("a max-turns exit is retryable AND counted against the budget", () => {
		const maxTurns = "[INFRA] Claude Code exited 1: Error: Reached max turns (100)"
		expect(isInfra(maxTurns)).toBe(true)
		expect(isTransientInfra(maxTurns)).toBe(true)
		expect(isBudgetExhaustion(maxTurns)).toBe(true)
	})

	// The budget predicate must not catch an ordinary transient failure: a 403
	// is retried with no ceiling, because it costs one refused request rather
	// than 30 minutes of a model.
	test.each([
		["a 403", '[INFRA] Claude Code exited 1: API Error: 403 {"type":"FreeTierError"}'],
		["a 429", "[INFRA] Claude Code exited 1: API Error: 429 rate_limit_error"],
		["a socket error", "[INFRA] Claude Code exited 1: socket hang up"],
		["a permanent install fault", "[INFRA] Claude Code binary not found"],
	])("not a budget exhaustion: %s", (_label, msg) => {
		expect(isBudgetExhaustion(msg)).toBe(false)
	})

	test.each([
		[
			"CLI not installed",
			"[INFRA] Claude Code binary not found (looked in /usr/local/bin/claude).",
		],
		["no credential at all", "[INFRA] no Anthropic credential in the worker environment."],
		[
			"not authenticated",
			"[INFRA] Claude Code is not authenticated (no usable ANTHROPIC_AUTH_TOKEN).",
		],
		[
			"a rejection unrelated to the request",
			"[INFRA] Claude Code exited 1: Error: Input must be provided",
		],
	])("permanent: %s", (_label, msg) => {
		expect(isInfra(msg)).toBe(true)
		expect(isTransientInfra(msg)).toBe(false)
	})

	test("a bare non-INFRA failure is neither", () => {
		expect(isInfra("Claude Code made no push")).toBe(false)
		expect(isTransientInfra("Claude Code made no push")).toBe(false)
	})

	test("stripInfra still removes the prefix for the recorded reason", () => {
		expect(stripInfra(FREE_TIER_403)).toBe(
			'Claude Code exited 1: Failed to authenticate. API Error: 403 [403]: {"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}}',
		)
	})
})

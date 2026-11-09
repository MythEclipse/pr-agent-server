// biome-ignore-all lint/suspicious/noExplicitAny: test fakes stand in for untyped GitHub payloads
/**
 * `stepMerge`'s disposition per HTTP status — specifically the 404 arm.
 *
 * WHY THIS FILE EXISTS. On 2026-11-09 `asepharyana/discord-forum-bridge#1` was
 * reported as "merge refused with HTTP 404 (attempt 57 at this SHA — retrying
 * next tick)" every five minutes. The repository had been deleted, so the head
 * SHA could never move, and `noteFailure`'s deliberate lack of a ceiling — right
 * for a refusal that a repo-side change can clear — turned a dead PR into an
 * infinite loop. The report also emitted a `failed` notification each tick, so
 * the operator's channel said a merge had failed 57 times for a PR that no
 * longer existed anywhere.
 *
 * A 404 is neither a refusal nor an outage: there is nothing left to merge and
 * nothing left to close. The only honest action is to stop tracking the PR,
 * which is what these tests pin.
 */
import { describe, expect, test } from "vitest"
import { stepMerge } from "../src/pr/gates.ts"

const REPO = "asepharyana/discord-forum-bridge"
const PR = 1
const HEAD = "fcb6eeae66214d5ff21b1c459338c16e3893fb42"

/**
 * Builds `deps` for `stepMerge`. The API answers in sequence: the first call is
 * `mergeableGate`'s re-read of the PR (which must say `mergeable: true` so the
 * gate passes and the merge is actually attempted), and every call after it
 * answers with the merge status under test.
 */
function harness(mergeStatus: number, message = "Not Found") {
	const report: string[] = []
	const saved: any[] = []
	let call = 0
	const deps = {
		dry: false,
		report: { push: (line: string) => report.push(line) },
		api: {
			request: async () => {
				const first = call++ === 0
				return first
					? { status: 200, data: { mergeable: true, mergeable_state: "clean" } }
					: { status: mergeStatus, data: { message } }
			},
		},
		fetchGhToken: () => "",
		notify: async () => {},
		sleep: async () => {},
		saveFixState: (state: any) => saved.push(JSON.parse(JSON.stringify(state))),
		workdirs: {
			exists: async () => false,
			mkdir: async () => {},
			remove: async () => {},
			writeFile: async () => {},
			readFile: async () => "",
		},
		procs: {
			workdirs: [],
			procExists: async () => false,
			kill: async () => {},
			sleep: async () => {},
			pid: async () => 0,
		},
	}
	return { deps: deps as any, report, saved }
}

function ctx(fixState: any) {
	return {
		repo: REPO,
		prNum: PR,
		headSha: HEAD,
		fixState,
		token: "tok",
		score: 0,
		title: "bump",
		out: {},
	} as any
}

describe("stepMerge — a 404 means the PR is GONE, not refused", () => {
	test("untracks the PR instead of counting an attempt", async () => {
		const { deps, report, saved } = harness(404)
		const fixState: any = {}

		expect(await stepMerge(deps, ctx(fixState), false)).toBe(false)

		const entry = fixState[REPO]?.[String(PR)]
		// The disposition is recorded at this head, which is what stops the next
		// tick from reading the PR at all.
		expect(entry?.skip_reason).toContain("gone")
		expect(entry?.skip_reason).toContain("404")
		// No failure tally: a tally is what produced "attempt 57".
		expect(entry?.attempts).toBeUndefined()
		expect(entry?.attempt_sha).toBeUndefined()
		// Persisted immediately, not left for a later tick that may never come.
		expect(saved).toHaveLength(1)
		expect(report.join("\n")).toContain("no longer exists")
		expect(report.join("\n")).toContain("Untracked")
	})

	test("never says it is retrying next tick", async () => {
		const { deps, report } = harness(404)
		await stepMerge(deps, ctx({}), false)
		// The old arm printed "🔁 ... retrying next tick" here, which was the lie:
		// nothing could ever change for a deleted repo.
		expect(report.join("\n")).not.toContain("retrying next tick")
	})

	test("a 422 refusal still counts and still retries", async () => {
		const { deps, report } = harness(422, "Validation Failed")
		const fixState: any = {}

		expect(await stepMerge(deps, ctx(fixState), false)).toBe(false)

		const entry = fixState[REPO]?.[String(PR)]
		// A refusal is mutable input: a repo-side rule change clears it, so it must
		// keep its unbounded tally and its retry line.
		expect(entry?.attempts).toBe(1)
		expect(entry?.skip_reason).toBeUndefined()
		expect(report.join("\n")).toContain("retrying next tick")
	})

	test("a 500 outage stays a transient deferral with no tally", async () => {
		const { deps, report } = harness(500, "boom")
		const fixState: any = {}

		expect(await stepMerge(deps, ctx(fixState), false)).toBe(false)

		expect(fixState[REPO]).toBeUndefined()
		expect(report.join("\n")).toContain("Merge deferred")
	})
})

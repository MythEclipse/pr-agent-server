// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code / test fixtures use untyped JSON shapes
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
	getSkipReason,
	loadFixState,
	loadSyncState,
	markFixed,
	markSkip,
	markSkipNotified,
	prEntry,
	pruneClosedFixState,
	saveFixState,
	saveSyncState,
	wasSkipNotified,
} from "../src/state.ts"

const tmpFile = (name: string) => join(mkdtempSync(join(tmpdir(), "st-")), name)

describe("fix state on-disk shape", () => {
	// Cut-over risk: the Python worker must still parse what we write. Whitespace
	// differs from Python's json.dumps separators, so pin the exact bytes here.
	test("saveFixState writes compact JSON with no indent", () => {
		const f = tmpFile("fix.json")
		saveFixState(f, { "o/r": { "1": { sha: "abc", notified: false } } })
		expect(readFileSync(f, "utf8")).toBe('{"o/r":{"1":{"sha":"abc","notified":false}}}')
	})

	test("saveFixState writes stringified PR keys, never numbers", () => {
		const f = tmpFile("fix.json")
		const s: any = {}
		markFixed(s, "o/r", 42, "abc")
		saveFixState(f, s)
		expect(Object.keys(JSON.parse(readFileSync(f, "utf8"))["o/r"])).toEqual(["42"])
	})

	test("markFixed drops skip_reason and resets notified", () => {
		const f = tmpFile("fix.json")
		const s: any = {}
		prEntry(s, "o/r", 7).skip_reason = "infra down"
		prEntry(s, "o/r", 7).notified = true
		markFixed(s, "o/r", 7, "newsha")
		saveFixState(f, s)
		expect(JSON.parse(readFileSync(f, "utf8"))["o/r"]["7"]).toEqual({
			sha: "newsha",
			// Defaults to 0 — "the agent found nothing to improve" — which is what
			// `shouldRetryAiFix` reads. Pinned so a silent default change cannot
			// turn every recorded fix into a re-offer.
			fix_commits: 0,
			notified: false,
		})
	})

	test("save then load round-trips", () => {
		const f = tmpFile("fix.json")
		const s: any = {}
		prEntry(s, "o/r", 3).sha = "deadbeef"
		saveFixState(f, s)
		expect(loadFixState(f)).toEqual(s)
	})

	// The Python mutators persisted as a side effect. A caller here that forgets
	// to save would re-fix the same PR every tick, so passing `file` must write.
	test("markFixed with a file persists without a separate saveFixState call", () => {
		const f = tmpFile("fix.json")
		const s: any = {}
		// `commits` before `file` — see markFixed's signature. Recorded as an exact
		// object so the new `fix_commits` field cannot slip in unnoticed: the
		// default is 0 and it is what `shouldRetryAiFix` reads.
		markFixed(s, "o/r", 5, "sha5", 0, f)
		expect(loadFixState(f)["o/r"]["5"]).toEqual({
			sha: "sha5",
			fix_commits: 0,
			notified: false,
		})
	})

	test("markFixed records how many commits the fix produced", () => {
		const s: any = {}
		markFixed(s, "o/r", 6, "sha6", 3)
		expect(s["o/r"]["6"].fix_commits).toBe(3)
	})

	test("markSkip and markSkipNotified persist when given a file", () => {
		const f = tmpFile("fix.json")
		const s: any = {}
		markSkip(s, "o/r", 6, "sha6", "infra down", f)
		expect(getSkipReason(loadFixState(f), "o/r", 6, "sha6")).toBe("infra down")
		expect(wasSkipNotified(loadFixState(f), "o/r", 6, "sha6")).toBe(false)
		markSkipNotified(s, "o/r", 6, "sha6", f)
		expect(wasSkipNotified(loadFixState(f), "o/r", 6, "sha6")).toBe(true)
	})

	test("omitting the file leaves the mutators in-memory (tests never touch prod state)", () => {
		const f = tmpFile("fix.json")
		const s: any = {}
		markFixed(s, "o/r", 8, "sha8")
		expect(existsSync(f)).toBe(false)
		expect(s["o/r"]["8"].sha).toBe("sha8")
	})
})

describe("sync state on-disk shape", () => {
	// The two files use DIFFERENT serializers on purpose; do not unify them.
	test("saveSyncState writes indent=1", () => {
		const f = tmpFile("sync.json")
		saveSyncState(f, { "a/b": {} })
		expect(readFileSync(f, "utf8")).toBe('{\n "a/b": {}\n}')
	})

	test("missing and corrupt sync state load the empty shape", () => {
		const dir = mkdtempSync(join(tmpdir(), "st-"))
		expect(loadSyncState(join(dir, "none.json"))).toEqual({})
		const bad = join(dir, "bad.json")
		writeFileSync(bad, "{not json")
		expect(loadSyncState(bad)).toEqual({})
	})

	test("an unwritable sync state path does not throw", () => {
		expect(() => saveSyncState("/proc/definitely/not/writable.json", { "a/b": {} })).not.toThrow()
	})
})

describe("pruning dead entries", () => {
	// The state file grew forever: on 2026-10-16 it still held entries for mcpedia
	// #23–#28, all merged, including #28's `attempts: 99`. Nothing read them —
	// `alreadyFixed`/`getSkipReason` are keyed on repo+PR+SHA and a closed PR never
	// comes back at the same SHA — so the only cost is a file that misleads whoever
	// reads it and grows without bound. That 99 is exactly the sort of number that
	// reads as "currently stuck" when it is six months dead.
	//
	// Entries for CLOSED or MERGED PRs are therefore dropped once a threshold of
	// open PRs is exceeded. Only ever removing provably-dead entries, and never
	// when it would shrink the file below the threshold, keeps this safe: the
	// worst case is that it does not run.
	test("closed and merged PRs are dropped", () => {
		const s: any = {
			"o/keep": { "1": { sha: "aaa" } },
			"o/drop": { "2": { sha: "bbb" }, "3": { sha: "ccc" } },
		}
		// `threshold: 0` so the guard's `<=` comparison is actually crossed — with
		// one open PR and `threshold: 1` the prune correctly declines to run, which
		// the next test pins.
		const open = new Set(["o/keep/1"])

		pruneClosedFixState(s, open, { threshold: 0 })

		// The repo object itself goes when its last PR is dead — leaving an empty
		// `{}` behind would make the file look like it still tracks that repo.
		expect(s["o/drop"]).toBeUndefined()
		expect(s["o/keep"]["1"]).toEqual({ sha: "aaa" })
	})

	test("no pruning while the file is under the threshold", () => {
		// The guard that makes this safe to ship: a bug in the open-PR set must not
		// be able to wipe live state.
		const s: any = { "o/r": { "1": { sha: "a" }, "2": { sha: "b" } } }
		pruneClosedFixState(s, new Set(["o/r", "o/other"]), { threshold: 10 })
		expect(Object.keys(s["o/r"])).toEqual(["1", "2"])
	})

	test("a PR seen as open is kept even in an otherwise dead repo", () => {
		// The key is `repo/number` — a bare repo name matches nothing, which is
		// exactly the mistake a caller could make.
		const s: any = { "o/r": { "7": { sha: "a" }, "8": { sha: "b" } } }
		pruneClosedFixState(s, new Set(["o/r/7"]), { threshold: 0 })
		expect(Object.keys(s["o/r"])).toEqual(["7"])
	})

	test("a SHORT scan prunes nothing — gatherOpenPrs returns [] on API failure", () => {
		// The safety argument, pinned. `gatherOpenPrs` returns `[]` when
		// `/app/installations` fails and deliberately ignores the HTTP status, so a
		// bad token or a rate limit is indistinguishable from "no open PRs".
		// Pruning on that list would delete every entry in the file.
		const s: any = { "o/r": { "1": { sha: "a" } }, "o/dead": { "2": { sha: "b" } } }
		// Two open PRs seen — below the threshold, so: no information, no action.
		const shortScan = new Set(["o/r/1"])
		expect(pruneClosedFixState(s, shortScan)).toBe(0)
		expect(s["o/dead"]["2"]).toEqual({ sha: "b" })

		// And with the default threshold rather than an injected one, so a change
		// to PRUNE_THRESHOLD cannot quietly weaken this.
		const s2: any = { "o/r": { "1": { sha: "a" } }, "o/dead": { "2": { sha: "b" } } }
		expect(pruneClosedFixState(s2, new Set(["o/r/1"]))).toBe(0)
		expect(s2["o/dead"]["2"]).toEqual({ sha: "b" })
	})

	test("an empty state is left alone", () => {
		const s: any = {}
		pruneClosedFixState(s, new Set(), { threshold: 0 })
		expect(s).toEqual({})
	})
})

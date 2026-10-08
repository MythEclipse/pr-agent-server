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
		markFixed(s, "o/r", 5, "sha5", f)
		expect(loadFixState(f)["o/r"]["5"]).toEqual({ sha: "sha5", notified: false })
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

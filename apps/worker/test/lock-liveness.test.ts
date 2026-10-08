import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { WorkerLock } from "../src/lock.ts"

const tmpLock = () => join(mkdtempSync(join(tmpdir(), "wl-")), "l.lock")

describe("WorkerLock liveness", () => {
	// If the lock file ever stopped recording the real PID, stale-recycling would
	// steal locks from running workers (or never recycle anything).
	test("records the current PID in the lock file", () => {
		const p = tmpLock()
		const l = WorkerLock.acquire(p)
		expect(readFileSync(p, "utf8")).toBe(String(process.pid))
		l?.release()
	})

	test("does not steal a lock held by this live process", () => {
		const p = tmpLock()
		const l = WorkerLock.acquire(p)
		expect(WorkerLock.acquire(p)).toBeNull()
		l?.release()
	})

	// Python int("garbage") raises ValueError -> steal. A naive parseInt would
	// read "12abc" as 12 and /proc/12 may not exist, and Number("") is 0.
	test("recycles a lock whose PID is not a number", () => {
		const p = tmpLock()
		writeFileSync(p, "not-a-pid")
		const l = WorkerLock.acquire(p)
		expect(l).not.toBeNull()
		l?.release()
	})

	test("recycles an empty lock file rather than reading it as PID 0", () => {
		const p = tmpLock()
		writeFileSync(p, "")
		const l = WorkerLock.acquire(p)
		expect(l).not.toBeNull()
		l?.release()
	})

	test("release is idempotent", () => {
		const p = tmpLock()
		const l = WorkerLock.acquire(p)
		l?.release()
		expect(() => l?.release()).not.toThrow()
	})
})

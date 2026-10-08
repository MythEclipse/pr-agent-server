import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { WorkerLock } from "../src/lock.ts"

describe("WorkerLock", () => {
	test("second acquire fails while the first holds it", () => {
		const p = join(mkdtempSync(join(tmpdir(), "wl-")), "l.lock")
		const a = WorkerLock.acquire(p)
		expect(a).not.toBeNull()
		expect(WorkerLock.acquire(p)).toBeNull()
		a?.release()
		expect(WorkerLock.acquire(p)).not.toBeNull()
	})

	test("recycles a stale lock whose PID is dead", () => {
		const p = join(mkdtempSync(join(tmpdir(), "wl-")), "l.lock")
		writeFileSync(p, "999999")
		const l = WorkerLock.acquire(p)
		expect(l).not.toBeNull()
		l?.release()
	})
})

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { acquireWithWait, WorkerLock } from "../src/lock.ts"

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

/**
 * `acquireWithWait` — the nightly job must outlast a tick, not lose to it.
 *
 * The tick holds the lock ~36s every 5 minutes; the sync holds it ~2.5 minutes
 * once a day. Failing instantly on contention gave the nightly a real chance of
 * dying on a collision that would clear in seconds, reported as
 * `Result: exit-code` — the same signal as a genuine failure, in a job whose
 * whole recent history was being misread because of that ambiguity.
 */
describe("acquireWithWait", () => {
	test("takes a free lock immediately", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "lockw-")), "free.lock")
		const lock = await acquireWithWait(path, 500, 10)
		expect(lock).not.toBeNull()
		lock?.release()
		expect(existsSync(path)).toBe(false)
	})

	test("waits for a holder that releases, then succeeds", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "lockw-")), "held.lock")
		// A live PID, so the lock is not recycled as stale.
		writeFileSync(path, String(process.pid))
		setTimeout(() => {
			rmSync(path, { force: true })
		}, 40)
		const lock = await acquireWithWait(path, 2_000, 10)
		expect(lock).not.toBeNull()
		lock?.release()
	})

	test("gives up after the budget instead of hanging forever", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "lockw-")), "stuck.lock")
		writeFileSync(path, String(process.pid))
		const started = Date.now()
		const lock = await acquireWithWait(path, 120, 10)
		expect(lock).toBeNull()
		// Bounded: it must not outlast its budget by much, or the unit's
		// TimeoutStartSec would kill it with a less useful message.
		expect(Date.now() - started).toBeLessThan(1_000)
		rmSync(path, { force: true })
	})
})

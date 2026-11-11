/**
 * `spawnSyncCompat` must not launder a kill into "exit 1".
 *
 * Node reports a signalled death as `status: null` plus `signal: "SIGTERM"`. The
 * old `status ?? 1` turned every kill into exit 1 — indistinguishable from the
 * child deciding to fail, and therefore pinnable as a permanent agent failure.
 * These tests run a REAL child that kills itself, so the assertion is against
 * Node's actual result shape rather than a hand-written stub.
 */
import { describe, expect, test } from "vitest"
import { spawnSyncCompat } from "../src/lib/proc.ts"

describe("spawnSyncCompat preserves a signalled death", () => {
	test("a child that dies by SIGTERM reports 143, not 1", () => {
		// `kill -TERM $$` in a shell: the shell dies by the signal, so Node gives
		// status null + signal SIGTERM.
		const r = spawnSyncCompat(["sh", "-c", "kill -TERM $$"])
		expect(r.code).toBe(143)
		expect(r.exitedDueToTimeout).toBe(false)
	})

	test("a child that dies by SIGKILL reports 137", () => {
		const r = spawnSyncCompat(["sh", "-c", "kill -KILL $$"])
		expect(r.code).toBe(137)
	})

	test("the signal is NAMED in stderr, so the report is not a bare number", () => {
		// Without this, the operator sees `exited 143:` with nothing after it and
		// has no way to tell a kill from a crash.
		const r = spawnSyncCompat(["sh", "-c", "kill -TERM $$"])
		expect(r.stderr).toContain("killed by SIGTERM")
	})

	test("an ordinary non-zero exit is unchanged", () => {
		// The signal handling must not disturb the normal path.
		const r = spawnSyncCompat(["sh", "-c", "exit 3"])
		expect(r.code).toBe(3)
		expect(r.exitedDueToTimeout).toBe(false)
	})

	test("success is still 0 with output captured", () => {
		const r = spawnSyncCompat(["sh", "-c", "echo hi"])
		expect(r.code).toBe(0)
		expect(r.stdout.trim()).toBe("hi")
	})

	test("a timeout still reports 124 and exitedDueToTimeout — not a signal", () => {
		// The timeout path and the kill path must stay distinct: one is our own
		// budget being spent, the other is someone else ending the process.
		const r = spawnSyncCompat(["sh", "-c", "sleep 5"], { timeout: 200 })
		expect(r.exitedDueToTimeout).toBe(true)
		expect(r.code).toBe(124)
	})
})

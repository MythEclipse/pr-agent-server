/**
 * Worker lock — port of `scripts/pr-queue-worker.py` lines 200-234
 * (`get_lock` / `release_lock`).
 *
 * Atomic claim via `O_CREAT|O_EXCL` (`openSync(..., "wx")` in Node/Bun), so two
 * workers can never both believe they hold it. A lock file left behind by a
 * crashed / `kill -9`ed worker is recycled by checking whether the recorded PID
 * is still alive under `/proc`.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"

/** Python `LOCK_FILE` (line 65) — the canonical path the run loop must claim. */
export const LOCK_FILE = "/tmp/pr-queue-worker.lock"

/**
 * Wait up to `budgetMs` for the worker lock, then give up.
 *
 * WHY A DAILY JOB MUST WAIT AND A TICK MUST NOT. The tick runs every five
 * minutes and holds the lock for ~36s; the nightly sync runs once a day and holds
 * it for ~2.5 MINUTES. Failing instantly on contention is fine for the tick —
 * another one is along in five minutes — but for the nightly it means a ~1-in-8
 * chance of dying on a collision that would have cleared in seconds, reported as
 * `Result: exit-code`, which is indistinguishable from a real failure. That is
 * precisely the noise this job was just dug out of.
 *
 * The budget is a few tick lengths, so a normal tick always clears inside it,
 * while a genuinely stuck run still fails rather than hanging the unit past its
 * `TimeoutStartSec`.
 */
export async function acquireWithWait(
	path: string,
	budgetMs = 120_000,
	pollMs = 2_000,
): Promise<WorkerLock | null> {
	const deadline = Date.now() + budgetMs
	for (;;) {
		const lock = WorkerLock.acquire(path)
		if (lock) return lock
		if (Date.now() >= deadline) return null
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
}

export class WorkerLock {
	private constructor(private readonly path: string) {}

	/**
	 * Try to claim `path`. Returns null when another live worker holds it.
	 * Throws only for non-`EEXIST` errors (e.g. a permission problem), matching
	 * Python, where only `FileExistsError` is caught.
	 */
	static acquire(path: string): WorkerLock | null {
		if (WorkerLock.claim(path)) return new WorkerLock(path)

		// EEXIST — read the recorded PID and decide whether the holder is alive.
		let alive = false
		try {
			const raw = readFileSync(path, "utf8").trim()
			// `int(raw)` semantics: whole-string integer only. `Number.parseInt`
			// would accept "12abc"; `Number` would accept "" as 0.
			const pid = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN
			if (Number.isNaN(pid)) throw new Error(`non-numeric PID in ${path}`)
			alive = existsSync(`/proc/${pid}`)
		} catch {
			alive = false // unreadable or non-numeric → treat as stale, same as Python
		}
		if (alive) return null

		// Stale lock: the holder is dead, so stealing is safe. Retry exactly ONCE —
		// a retry loop would spin against a lock that keeps being recreated.
		try {
			unlinkSync(path) // Python `unlink(missing_ok=True)`
		} catch {
			/* already gone, or unremovable — the retry below decides */
		}
		return WorkerLock.claim(path) ? new WorkerLock(path) : null
	}

	/** Release the lock. Safe to call more than once. */
	release(): void {
		try {
			unlinkSync(this.path)
		} catch {
			/* missing_ok semantics */
		}
	}

	/**
	 * One `O_EXCL` open + PID write. The fd is closed on every path, including
	 * the failure paths — this worker runs for the life of a cron tick and a
	 * leaked descriptor would accumulate (Python's `finally`, lines 226-231).
	 */
	private static claim(path: string): boolean {
		let fd: number | null = null
		try {
			fd = openSync(path, "wx", 0o644)
			writeSync(fd, String(process.pid))
			closeSync(fd)
			fd = null
			return true
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
			throw err
		} finally {
			if (fd !== null) {
				try {
					closeSync(fd)
				} catch {
					/* already closed */
				}
			}
		}
	}
}

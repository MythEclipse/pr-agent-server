/**
 * Worker lock — port of `scripts/pr-queue-worker.py` lines 200-234
 * (`get_lock` / `release_lock`).
 *
 * Atomic claim via `O_CREAT|O_EXCL` (`openSync(..., "wx")` in Node/Bun), so two
 * workers can never both believe they hold it. A lock file left behind by a
 * crashed / `kill -9`ed worker is recycled by checking whether the recorded PID
 * is still alive under `/proc`.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/** Python `LOCK_FILE` (line 65) — the canonical path the run loop must claim. */
export const LOCK_FILE = "/tmp/pr-queue-worker.lock";

export class WorkerLock {
  private constructor(private readonly path: string) {}

  /**
   * Try to claim `path`. Returns null when another live worker holds it.
   * Throws only for non-`EEXIST` errors (e.g. a permission problem), matching
   * Python, where only `FileExistsError` is caught.
   */
  static acquire(path: string): WorkerLock | null {
    if (WorkerLock.claim(path)) return new WorkerLock(path);

    // EEXIST — read the recorded PID and decide whether the holder is alive.
    let alive = false;
    try {
      const raw = readFileSync(path, "utf8").trim();
      // `int(raw)` semantics: whole-string integer only. `Number.parseInt`
      // would accept "12abc"; `Number` would accept "" as 0.
      const pid = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (Number.isNaN(pid)) throw new Error(`non-numeric PID in ${path}`);
      alive = existsSync(`/proc/${pid}`);
    } catch {
      alive = false; // unreadable or non-numeric → treat as stale, same as Python
    }
    if (alive) return null;

    // Stale lock: the holder is dead, so stealing is safe. Retry exactly ONCE —
    // a retry loop would spin against a lock that keeps being recreated.
    try {
      unlinkSync(path); // Python `unlink(missing_ok=True)`
    } catch {
      /* already gone, or unremovable — the retry below decides */
    }
    return WorkerLock.claim(path) ? new WorkerLock(path) : null;
  }

  /** Release the lock. Safe to call more than once. */
  release(): void {
    try {
      unlinkSync(this.path);
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
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx", 0o644);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      fd = null;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    }
  }
}

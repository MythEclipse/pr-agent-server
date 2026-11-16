// In-process review queue: FIFO, dedupes a pull request that is already queued
// or running, and caps how many reviews execute at once so a burst of webhooks
// cannot stampede the LLM. `enqueue` is synchronous — the webhook handler never
// awaits a review. A failing job is logged and the queue keeps going.
// A push that lands while a review is running is deduped, so that PR is
// re-queued once when the run settles — the re-run re-reads the current head.

import type { TQueueStats } from "../../domain/review/queue-repository.ts"

export interface ReviewJob {
	owner: string
	repo: string
	pr: number
	/**
	 * The PR's head commit, when the delivery carries one.
	 *
	 * The in-memory queue does not need it to decide anything — it keeps no
	 * history, so a settled job's key is gone and the next delivery always
	 * re-queues. The persistent queue DOES need it: a `done` row is only
	 * re-armed when the delivery names a different commit, and a job that
	 * cannot say which commit it is for would either never be re-reviewed or be
	 * re-reviewed on every redelivery. Passed through unchanged for parity.
	 */
	headSha?: string
}

/**
 * The counters both backends report. Aliased from the domain type so the two
 * cannot drift into "nearly the same shape", which is how a dashboard ends up
 * reading `undefined` from one of them.
 */
export type QueueStats = TQueueStats

export interface ReviewQueueOptions {
	/** Max reviews running at the same time. Default 1 (serial). */
	concurrency?: number
	run: (job: ReviewJob) => Promise<void>
	log?: (m: string) => void
}

const keyOf = (job: ReviewJob): string => `${job.owner}/${job.repo}#${job.pr}`

export class ReviewQueue {
	private readonly concurrency: number
	private readonly run: (job: ReviewJob) => Promise<void>
	private readonly log: (m: string) => void
	/** Jobs waiting for a free slot, in arrival order. */
	private readonly pending: ReviewJob[] = []
	/** Keys of every job queued or running; an entry clears when the job settles. */
	private readonly inFlight = new Set<string>()
	/** Keys that got a duplicate while running — one coalesced re-run follows. */
	private readonly rerun = new Set<string>()
	private running = 0
	private waiters: (() => void)[] = []
	/**
	 * Terminal outcomes, for `stats()`.
	 *
	 * THE DB BACKEND KEEPS A ROW PER OUTCOME; this one keeps a tally, because it
	 * exists for development and holds no history. Without the tally the two
	 * backends disagreed about a failing review: Postgres recorded `failed` (and
	 * a later webhook re-armed it), while the in-memory queue logged the error
	 * and dropped the job, leaving nothing to observe. The RETRY behaviour was
	 * already equivalent — a settled key is released here and re-armed there —
	 * so this is the observability half of the parity.
	 */
	private readonly settled = { done: 0, failed: 0 }

	constructor(opts: ReviewQueueOptions) {
		this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1))
		this.run = opts.run
		this.log = opts.log ?? ((m: string) => console.error(m))
	}

	/**
	 * Queue a review, or report "deduped" when that PR is already queued/running.
	 * A deduped PR is re-queued once the in-flight run settles, so a push that
	 * lands mid-review is never dropped — the re-run reads the current head.
	 */
	enqueue(job: ReviewJob): "queued" | "deduped" {
		const key = keyOf(job)
		if (this.inFlight.has(key)) {
			this.rerun.add(key)
			return "deduped"
		}
		this.inFlight.add(key)
		this.pending.push(job)
		this.pump()
		return "queued"
	}

	/** Jobs waiting for a free slot (excludes the ones currently running). */
	size(): number {
		return this.pending.length
	}

	/**
	 * The same four counters the persistent queue's `stats()` reports.
	 *
	 * `done` and `failed` count settled RUNS, not rows: this queue holds no
	 * history, so a job that was re-run after a coalesced re-request counts
	 * twice. The DB backend counts current rows instead. The shapes are the same
	 * so a dashboard or a test can read either backend without knowing which is
	 * mounted.
	 */
	stats(): QueueStats {
		return {
			pending: this.pending.length,
			running: this.running,
			done: this.settled.done,
			failed: this.settled.failed,
		}
	}

	/** Resolves once the queue is empty and no job is running. */
	drain(): Promise<void> {
		if (this.running === 0 && this.pending.length === 0) return Promise.resolve()
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve)
		})
	}

	/** Fill free slots from the head of the queue. */
	private pump(): void {
		while (this.running < this.concurrency && this.pending.length > 0) {
			// The length check above guarantees a shift; `!` would hide a future refactor bug.
			const job = this.pending.shift() as ReviewJob
			this.running++
			void this.execute(job)
		}
	}

	private async execute(job: ReviewJob): Promise<void> {
		const key = keyOf(job)
		try {
			await this.run(job)
			this.settled.done += 1
		} catch (e) {
			// A failing job must never wedge the queue: record it and move on,
			// which is what the persistent queue does too — and count it, so the
			// failure is observable rather than only a log line.
			this.settled.failed += 1
			try {
				this.log(
					`[queue] review job ${key} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
				)
			} catch {
				// A throwing logger must not strand the queue.
			}
		} finally {
			this.inFlight.delete(key)
			// Coalesced re-run: the deduped webhook(s) landed while this ran, so
			// review the PR again against its current head. Doing it here — before
			// the idle check below — keeps the "pending implies running" invariant.
			const rerun = this.rerun.delete(key)
			if (rerun) this.pending.push(job)
			this.running--
			this.pump()
			// No `return` inside `finally`: it would swallow a throw from the try
			// block above. The rerun case only skips the idle check, which cannot
			// be correct anyway — a job was just re-queued, so the queue is not idle.
			if (!rerun && this.running === 0 && this.pending.length === 0) {
				const waiters = this.waiters
				this.waiters = []
				for (const resolve of waiters) resolve()
			}
		}
	}
}

// The QueueRepository-backed review queue.
//
// This is the half of P3 that makes the review queue survive a restart. It
// exposes the same surface the in-memory implementation does — enqueue with
// coalescing dedupe, a `run` callback, and `drain()` for tests — but state
// lives in Postgres rather than in a Set that a crash erases.

import type { ReviewJob } from "../../application/queue/review-queue.ts"
import type { QueueRepository } from "../../domain/review/queue-repository.ts"

export interface IDbReviewQueue {
	enqueue(job: ReviewJob): Promise<"queued" | "deduped">
	/** Re-claim interrupted work and start pumping. Call once on boot. */
	start(): Promise<void>
	/** Resolves when nothing is in flight. */
	drain(): Promise<void>
	readonly backend: "db"
}

export interface DbReviewQueueOptions {
	store: QueueRepository
	concurrency: number
	run: (job: ReviewJob) => Promise<void>
	log?: (message: string) => void
	pollIntervalMs?: number
}

/**
 * Persistent review queue. `claimDue` is SKIP LOCKED under the hood, so two
 * API processes can share one database without double-reviewing a PR — which
 * would otherwise post a second GitHub comment for the same head SHA.
 */
export function makeDbReviewQueue(opts: DbReviewQueueOptions): IDbReviewQueue {
	const { store, concurrency, run, log = console.error, pollIntervalMs = 1_000 } = opts
	const cap = Math.max(1, Math.floor(concurrency))

	let inFlight = 0
	let pumping = false
	const stopped = false
	const idleWaiters: (() => void)[] = []

	const settleIfIdle = () => {
		if (inFlight === 0) {
			while (idleWaiters.length > 0) idleWaiters.pop()?.()
		}
	}

	const execute = async (job: ReviewJob): Promise<void> => {
		inFlight++
		const key = `${job.owner}/${job.repo}#${job.pr}`
		let rerun = false
		try {
			await run(job)
			// `complete` reports whether a webhook landed while this ran. It puts the
			// row back on `pending` itself, so all this side needs to do is know that
			// there IS work — the next `pump()` claims it.
			rerun = (await store.complete(key)).rerun
		} catch (err) {
			// A failing job must never wedge the queue: record it and move on,
			// which is what the in-memory queue does too.
			log(`[queue] review FAILED for ${key}: ${String(err)}`)
			await store.complete(key, String(err))
		} finally {
			inFlight--
			// A re-queued job means the queue is NOT idle: pump immediately instead
			// of waiting out the poll interval. `settleIfIdle` still runs once the
			// pump has claimed — it is a no-op when a job was taken, and it releases
			// `drain()` in the (impossible-but-cheap) case that nothing was due, so a
			// waiter can never be stranded on a rerun that produced no work.
			if (rerun) void pump().then(settleIfIdle, settleIfIdle)
			else settleIfIdle()
		}
	}

	const pump = async (): Promise<void> => {
		if (stopped || pumping) return
		const slots = cap - inFlight
		if (slots <= 0) return
		pumping = true
		try {
			const due = await store.claimDue(slots)
			for (const job of due) {
				void execute({ owner: job.owner, repo: job.repo, pr: job.pr })
			}
		} catch (err) {
			log(`[queue] claim failed: ${String(err)}`)
		} finally {
			pumping = false
		}
	}

	const loop = async (): Promise<void> => {
		while (!stopped) {
			await pump()
			if (stopped) break
			if (inFlight >= cap) {
				await new Promise<void>((r) => idleWaiters.push(r))
			} else {
				await new Promise<void>((r) => setTimeout(r, pollIntervalMs))
			}
		}
	}

	return {
		backend: "db",
		async enqueue(job: ReviewJob) {
			const { deduped } = await store.enqueue({ owner: job.owner, repo: job.repo, pr: job.pr })
			if (!deduped) void pump()
			return deduped ? ("deduped" as const) : ("queued" as const)
		},
		async start() {
			const requeued = await store.requeueInterrupted()
			if (requeued > 0) {
				log(`[queue] requeued ${requeued} job(s) interrupted by a restart`)
			}
			void loop()
		},
		async drain() {
			// WAIT FOR THE ROWS, NOT FOR `inFlight`.
			//
			// `inFlight` only counts what has been CLAIMED. Probed: six jobs at
			// concurrency 2 returned from `drain()` after 123ms with 2 completed and
			// 4 rows still `pending`/`running` — because the `while (inFlight > 0)`
			// loop saw zero between poll ticks and resolved immediately. That makes
			// `drain()` useless for both of its callers: a test asserting on the
			// results reads a half-finished queue, and a graceful shutdown lets the
			// process exit with unclaimed work still in the table.
			//
			// So: stop the loop taking new work, then wait until nothing is left
			// unsettled in the store. `inFlight > 0` is still checked because a job
			// claimed but not yet marked running-in-store is invisible to `stats()`.
			while (true) {
				await pump()
				const stats = await store.stats()
				if (inFlight === 0 && stats.pending === 0 && stats.running === 0) return
				await new Promise<void>((r) => setTimeout(r, pollIntervalMs))
			}
		},
	}
}

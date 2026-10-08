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
		try {
			await run(job)
			await store.complete(`${job.owner}/${job.repo}#${job.pr}`)
		} catch (err) {
			// A failing job must never wedge the queue: record it and move on,
			// which is what the in-memory queue does too.
			log(`[queue] review FAILED for ${job.owner}/${job.repo}#${job.pr}: ${String(err)}`)
			await store.complete(`${job.owner}/${job.repo}#${job.pr}`, String(err))
		} finally {
			inFlight--
			settleIfIdle()
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
			while (inFlight > 0) {
				await new Promise<void>((r) => idleWaiters.push(r))
			}
		},
	}
}

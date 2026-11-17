// The queue's persistence port.
//
// The application layer's ReviewQueue talks only to this interface, so the
// in-memory and Postgres backends are interchangeable and both can be unit
// tested with a plain fake. `key` is the dedupe key (`owner/repo#pr`) the
// in-memory queue already builds, so a job enqueued through either backend
// dedupes identically.

import type { TQueueState } from "../../infrastructure/db/schema.ts"

export interface TQueueJob {
	id: number
	key: string
	owner: string
	repo: string
	pr: number
	state: TQueueState
	attempts: number
	/** The commit this job was last requested for; null when unknown. */
	headSha: string | null
	rerunRequested: boolean
	runAfter: Date
	lastError: string | null
	createdAt: Date
	updatedAt: Date
}

export interface TEnqueueInput {
	owner: string
	repo: string
	pr: number
	/**
	 * The PR's head commit, when the delivery carries one.
	 *
	 * Load-bearing for the DONE row: a job that already finished must be
	 * re-armed when a NEW commit arrives, and left alone when the same commit
	 * arrives again. Without it the only options were "never re-review" (a push
	 * after a review was silently dropped) or "always re-review" (every
	 * redelivery of one webhook buys a second LLM review).
	 */
	headSha?: string | null
}

export interface TQueueStats {
	pending: number
	running: number
	done: number
	failed: number
}

/**
 * What settling a job decided. `rerun` is true when the job was put back on
 * `pending` because a webhook arrived while it was running, so the pump knows
 * there is more work immediately rather than after the next poll interval.
 */
export interface TCompleteResult {
	rerun: boolean
}

export interface QueueRepository {
	/**
	 * Insert a job, or return the existing one when `key` is already queued or
	 * running. Implementations set `rerunRequested` on the existing row rather
	 * than inserting a duplicate — the same coalescing the in-memory queue does.
	 */
	enqueue(input: TEnqueueInput): Promise<{ job: TQueueJob; deduped: boolean }>

	/** Jobs eligible to run now, oldest first, marked `running`. */
	claimDue(limit: number): Promise<TQueueJob[]>

	/** Move a job to a terminal state, recording any error. */
	complete(key: string, error?: string | null): Promise<TCompleteResult>

	/**
	 * Re-queue every job left `running` by a crash. Called once on boot so an
	 * interrupted review is retried rather than lost (at-least-once).
	 */
	requeueInterrupted(): Promise<number>
	/**
	 * Re-arm recent failures, bounded by attempt count and age.
	 *
	 * Returns how many rows were requeued. See the implementation for why a failed
	 * job must not be terminal.
	 */
	requeueFailed(opts: { maxAttempts: number; withinMs: number }): Promise<number>

	stats(): Promise<TQueueStats>
}

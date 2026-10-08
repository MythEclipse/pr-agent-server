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
}

export interface TQueueStats {
	pending: number
	running: number
	done: number
	failed: number
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
	complete(key: string, error?: string | null): Promise<void>

	/**
	 * Re-queue every job left `running` by a crash. Called once on boot so an
	 * interrupted review is retried rather than lost (at-least-once).
	 */
	requeueInterrupted(): Promise<number>

	stats(): Promise<TQueueStats>
}

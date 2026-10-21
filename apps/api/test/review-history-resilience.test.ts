// A history-write failure must not destroy the review it describes.
//
// `record-review.ts` states the contract in prose: "A failure to record history
// must never fail the review it describes: the comment is already on the PR".
// `finish()` honours it (try/catch, log and continue). `start()` did not — and
// `start()` is the worse one to leave unguarded, because it runs BEFORE the
// review: `main.ts` does
//
//     const reviewId = await history.start({...})
//     try { await useCases.legacy.runReview(...) } ...
//
// so a throwing INSERT there aborts `runJob` before `runReview` is ever called.
// The PR gets no comment, the queue marks the job `failed`, and the cause is a
// bookkeeping table rather than anything to do with the review.
//
// The reverse punt is equally wrong: swallowing the failure and returning a
// bogus id would make `finish()` UPDATE a row that does not exist. So `start()`
// must report "no row" distinctly, and the caller must cope with it.

import { describe, expect, test, vi } from "vitest"
import { makeRecordReview } from "../src/application/review/record-review.ts"
import type { ReviewRepository } from "../src/domain/review/review-repository.ts"

const FAILING_STORE = new Error('insert failed: relation "reviews" does not exist')

/** A repository whose every write fails, like a deploy that missed a migration. */
const brokenReviews = (): ReviewRepository =>
	({
		insertReview: () => Promise.reject(FAILING_STORE),
		updateReview: () => Promise.reject(FAILING_STORE),
		listReviews: () => Promise.resolve({ rows: [], total: 0 }),
		getReview: () => Promise.resolve(null),
	}) as unknown as ReviewRepository

describe("history write failures", () => {
	test("start() does not throw when the insert fails, and reports no row", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const history = makeRecordReview({ reviews: brokenReviews() })

		// The whole point: this must RESOLVE, so `runJob` reaches `runReview`.
		// Returning null (not an id) is what tells the caller there is no row to
		// finish later.
		const id = await history.start({ owner: "o", repo: "r", pr: 1 })

		expect(id).toBeNull()
		expect(errors).toHaveBeenCalled()
		errors.mockRestore()
	})

	test("finish() tolerates a null id from a failed start", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const history = makeRecordReview({ reviews: brokenReviews() })

		// There is no row, so there is nothing to update and nothing to throw.
		await expect(
			history.finish(null, { owner: "o", repo: "r", pr: 1, status: "success" }),
		).resolves.toBeUndefined()
		errors.mockRestore()
	})

	test("a healthy store still returns the inserted id", async () => {
		// Guard against the fix being "always return null", which would silence
		// every history write while all the tests above still pass.
		let inserted = 0
		const repo = {
			insertReview: () => {
				inserted += 1
				return Promise.resolve({ id: 42 })
			},
			updateReview: () => Promise.resolve(),
			listReviews: () => Promise.resolve({ rows: [], total: 0 }),
			getReview: () => Promise.resolve(null),
		} as unknown as ReviewRepository

		const history = makeRecordReview({ reviews: repo })
		await expect(history.start({ owner: "o", repo: "r", pr: 1 })).resolves.toBe(42)
		expect(inserted).toBe(1)
	})
})

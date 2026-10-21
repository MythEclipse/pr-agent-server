// Review HISTORY is written, and the dashboard reads it.
//
// This file exists because of a measured production fact: the live database had
// 88 `review_queue_jobs` rows in state='done' and ZERO rows in `reviews`. Every
// review the system had ever run was invisible in the UI, and the list page's
// "No reviews yet." was not a rendering bug — nothing had ever inserted a row.
//
// So these tests drive the real repository (PGlite applies the committed
// migrations, exactly as a deploy does) and assert the two properties the UI
// depends on: a row exists per attempt, and it reaches a terminal status with
// the fields the detail page renders.

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { extractReviewScore, makeRecordReview } from "../src/application/review/record-review.ts"
import { createReviewRepository } from "../src/infrastructure/db/repositories/review-repository.ts"
import { createTestDb, type ITestDb } from "./helpers/test-db.ts"

let store: ITestDb

beforeEach(async () => {
	store = await createTestDb()
})

afterEach(async () => {
	await store.close()
})

describe("review history", () => {
	test("a successful review leaves ONE row the dashboard can list", async () => {
		const reviews = createReviewRepository(store.db)
		const history = makeRecordReview({ reviews })

		const id = await history.start({ owner: "o", repo: "r", pr: 5 })
		// Visible while it is still running, not only after it finishes: a review
		// that takes the process down must not be absent from the history.
		expect((await reviews.getReview(id))?.status).toBe("queued")

		await history.finish(id, {
			owner: "o",
			repo: "r",
			pr: 5,
			status: "success",
			model: "claude-sonnet-5",
			markdown: "## PR Reviewer Guide 🔍",
			score: "82/100",
			headSha: "abc123",
		})

		const page = await reviews.listReviews({ owner: "o", repo: "r" })
		expect(page.total).toBe(1)
		const row = page.rows[0]
		expect(row?.status).toBe("success")
		expect(row?.model).toBe("claude-sonnet-5")
		expect(row?.markdown).toBe("## PR Reviewer Guide 🔍")
		expect(row?.score).toBe("82/100")
		expect(row?.headSha).toBe("abc123")
		// The detail page renders a duration from these two.
		expect(row?.startedAt).toBeInstanceOf(Date)
		expect(row?.finishedAt).toBeInstanceOf(Date)
	})

	test("a failed review records the error and no markdown", async () => {
		const reviews = createReviewRepository(store.db)
		const history = makeRecordReview({ reviews })

		const id = await history.start({ owner: "o", repo: "r", pr: 6 })
		await history.finish(id, {
			owner: "o",
			repo: "r",
			pr: 6,
			status: "failed",
			error: "All models failed: failed to parse review response",
		})

		const row = await reviews.getReview(id)
		expect(row?.status).toBe("failed")
		expect(row?.error).toContain("failed to parse")
		expect(row?.markdown).toBeNull()
	})

	test("each attempt is its own row, so a re-review keeps history", async () => {
		const reviews = createReviewRepository(store.db)
		const history = makeRecordReview({ reviews })

		for (const sha of ["first", "second"]) {
			const id = await history.start({ owner: "o", repo: "r", pr: 7 })
			await history.finish(id, { owner: "o", repo: "r", pr: 7, status: "success", headSha: sha })
		}

		const page = await reviews.listReviews({ owner: "o", repo: "r", pr: 7 })
		expect(page.total).toBe(2)
		expect(page.rows.map((r) => r.headSha)).toEqual(["second", "first"])
	})

	test("a history write failure never fails the review it describes", async () => {
		// The comment is already on the PR by the time this runs. Turning a
		// successful review into a thrown error because one UPDATE failed would
		// make the queue re-run work that already happened.
		const history = makeRecordReview({
			reviews: {
				insertReview: async () => {
					throw new Error("db down")
				},
				updateReview: async () => {
					throw new Error("db down")
				},
				getReview: async () => null,
				listReviews: async () => ({ rows: [], total: 0 }),
			},
		})
		await expect(
			history.finish(1, { owner: "o", repo: "r", pr: 1, status: "success" }),
		).resolves.toBeUndefined()
	})
})

describe("score extraction", () => {
	test("reads the score out of the model's YAML", () => {
		expect(extractReviewScore({ review: { score: 89 } })).toBe("89")
		expect(extractReviewScore({ review: { score: "82/100" } })).toBe("82/100")
	})
	test("returns null rather than the string 'undefined'", () => {
		// `String(undefined)` reaching this column would render as the literal
		// text "undefined" in the Score cell, which reads as a real value.
		expect(extractReviewScore(null)).toBeNull()
		expect(extractReviewScore({})).toBeNull()
		expect(extractReviewScore({ review: {} })).toBeNull()
		expect(extractReviewScore({ review: { score: "" } })).toBeNull()
	})
})

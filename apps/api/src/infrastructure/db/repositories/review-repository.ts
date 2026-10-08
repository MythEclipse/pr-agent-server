// Drizzle adapter for ReviewRepository. Returns plain domain shapes; no
// Drizzle type escapes this file (skill §5).

import { and, count, desc, eq, type SQL } from "drizzle-orm"
import type { PgDatabase } from "drizzle-orm/pg-core"
import type {
	ReviewFilter,
	ReviewRepository,
	TNewReviewRow,
	TReviewPage,
	TReviewRow,
} from "../../../domain/review/review-repository.ts"
import { reviews } from "../schema.ts"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Generic over the driver rather than pinned to one. Production uses the
 * node-postgres handle from `createDb`; the integration tests use the in-memory
 * pglite handle. Both are Postgres, but their session *result* HKTs differ, so
 * naming either driver here would make the other uncompilable. PgDatabase is
 * the base both share; the query-builder surface used below is identical.
 */
export function createReviewRepository<TDb extends PgDatabase<any, any>>(
	db: TDb,
): ReviewRepository {
	return {
		async insertReview(row: TNewReviewRow): Promise<TReviewRow> {
			const inserted = await db.insert(reviews).values(row).returning()
			const created = inserted[0]
			if (!created) throw new Error("insertReview returned no row")
			return created
		},

		async updateReview(id: number, patch: Partial<TNewReviewRow>): Promise<TReviewRow | null> {
			const updated = await db
				.update(reviews)
				.set({ ...patch, updatedAt: new Date() })
				.where(eq(reviews.id, id))
				.returning()
			return updated[0] ?? null
		},

		async getReview(id: number): Promise<TReviewRow | null> {
			const found = await db.select().from(reviews).where(eq(reviews.id, id)).limit(1)
			return found[0] ?? null
		},

		async listReviews(filter: ReviewFilter): Promise<TReviewPage> {
			const clauses: SQL[] = []
			if (filter.owner !== undefined) clauses.push(eq(reviews.owner, filter.owner))
			if (filter.repo !== undefined) clauses.push(eq(reviews.repo, filter.repo))
			if (filter.pr !== undefined) clauses.push(eq(reviews.pr, filter.pr))
			if (filter.status !== undefined) clauses.push(eq(reviews.status, filter.status as never))
			if (filter.kind !== undefined) clauses.push(eq(reviews.kind, filter.kind as never))
			const where = clauses.length > 0 ? and(...clauses) : undefined

			const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
			const offset = Math.max(filter.offset ?? 0, 0)

			const [rows, totals] = await Promise.all([
				db
					.select()
					.from(reviews)
					.where(where)
					.orderBy(desc(reviews.createdAt), desc(reviews.id))
					.limit(limit)
					.offset(offset),
				db.select({ value: count() }).from(reviews).where(where),
			])

			return { rows, total: totals[0]?.value ?? 0 }
		},
	}
}

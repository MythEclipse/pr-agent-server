// Drizzle adapter for ReviewRepository. Returns plain domain shapes; no
// Drizzle type escapes this file (skill §5).

import { and, count, desc, eq, isNull, lt, type SQL } from "drizzle-orm"
import type { PgDatabase } from "drizzle-orm/pg-core"
import type { TReviewStatus } from "../../../domain/review/review.ts"
import type {
	ReviewFilter,
	ReviewRepository,
	TNewReviewRow,
	TReviewPage,
	TReviewRow,
} from "../../../domain/review/review-repository.ts"
import { reviews } from "../schema.ts"

/**
 * The query surface a repository needs, generic over the driver.
 *
 * PgDatabase's first generic is the driver's query-result type, which differs
 * between the node-postgres handle production uses and the pglite handle the
 * integration tests use. `unknown` is not accepted there, so this alias holds
 * the single unavoidable `any` rather than repeating it at each use site.
 */
// biome-ignore lint/suspicious/noExplicitAny: documented above
export type TAnyPgDatabase = PgDatabase<any, any>

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Generic over the driver rather than pinned to one. Production uses the
 * node-postgres handle from `createDb`; the integration tests use the in-memory
 * pglite handle. Both are Postgres, but their session *result* HKTs differ, so
 * naming either driver here would make the other uncompilable. PgDatabase is
 * the base both share; the query-builder surface used below is identical.
 */
export function createReviewRepository<TDb extends TAnyPgDatabase>(db: TDb): ReviewRepository {
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

		/**
		 * `desc(reviews.id)`, not `started_at`: two deliveries can land in the same
		 * millisecond, and the row this run belongs to is always the last one
		 * written. `for("update")` is deliberately NOT used — the update below is
		 * a single statement against a known id, so there is no read-then-write
		 * window worth locking for.
		 */
		async markRunning(owner, repo, pr, startedAt) {
			const queued = await db
				.select({ id: reviews.id })
				.from(reviews)
				.where(
					and(
						eq(reviews.owner, owner),
						eq(reviews.repo, repo),
						eq(reviews.pr, pr),
						eq(reviews.status, "queued"),
					),
				)
				.orderBy(desc(reviews.id))
				.limit(1)

			const id = queued[0]?.id
			if (id === undefined) return null

			const updated = await db
				.update(reviews)
				.set({ status: "running", startedAt, updatedAt: new Date() })
				.where(eq(reviews.id, id))
				.returning()
			return updated[0] ?? null
		},

		async markInterrupted(before: Date, message: string): Promise<number> {
			// `finished_at IS NULL` is the whole predicate, and it is enough: a
			// terminal row always carries a finish time (`finish()` sets it), so an
			// open row can only mean the process that owned it is gone. The
			// `started_at < before` bound is what keeps a review that another
			// process is running RIGHT NOW from being failed by this boot.
			const healed = await db
				.update(reviews)
				.set({
					status: "failed",
					error: message,
					finishedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(and(isNull(reviews.finishedAt), lt(reviews.startedAt, before)))
				.returning({ id: reviews.id })
			return healed.length
		},

		async countByStatus(): Promise<Record<TReviewStatus, number>> {
			const rows = await db
				.select({ status: reviews.status, value: count() })
				.from(reviews)
				.groupBy(reviews.status)

			// Seeded with every status, not just the ones the GROUP BY returned: a
			// status with no rows must read 0 in the dashboard, not vanish.
			const out: Record<TReviewStatus, number> = {
				queued: 0,
				running: 0,
				success: 0,
				failed: 0,
			}
			for (const row of rows) out[row.status] = row.value
			return out
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

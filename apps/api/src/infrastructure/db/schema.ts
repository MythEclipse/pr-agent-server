// Drizzle schema — the source of truth for review history and the queue.
//
// Naming follows the skill's §5 guidance: snake_case columns, camelCase
// properties, explicit createdAt/updatedAt on every table. Two concerns live
// here and nothing else:
//
//   reviews           — history the dashboard reads. A row is written once per
//                       review attempt and only moves to a terminal status.
//   review_queue_jobs — the restart-surviving queue. `key` is the same dedupe
//                       key the in-memory ReviewQueue uses (`owner/repo#pr`),
//                       so both backends dedupe identically.
//
// NOT here on purpose: the worker's /tmp/pr-queue-*.json contracts. Those are
// byte-compatible with the deleted Python worker and are relied on by the
// systemd units (PrivateTmp=false); moving them is an ops migration, not a
// schema change.

import { boolean, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core"

/** What kind of review produced a `reviews` row. */
export const reviewKind = ["review", "describe", "improve"] as const
export type TReviewKind = (typeof reviewKind)[number]

/** Lifecycle of a review attempt. `queued` is written at enqueue time. */
export const reviewStatus = ["queued", "running", "success", "failed"] as const
export type TReviewStatus = (typeof reviewStatus)[number]

/** Queue job state. `running` is reset to `pending` on boot (at-least-once). */
export const queueState = ["pending", "running", "done", "failed"] as const
export type TQueueState = (typeof queueState)[number]

export const reviews = pgTable(
	"reviews",
	{
		id: serial("id").primaryKey(),
		owner: text("owner").notNull(),
		repo: text("repo").notNull(),
		pr: integer("pr").notNull(),
		kind: text("kind").$type<TReviewKind>().notNull().default("review"),
		status: text("status").$type<TReviewStatus>().notNull().default("queued"),
		/** Model that actually answered, after any fallback. */
		model: text("model"),
		/** Rendered review markdown, as published to GitHub. */
		markdown: text("markdown"),
		/** Kept as text because the prompt may emit "8", "8/10" or "85%". */
		score: text("score"),
		/** Failure message when status is `failed`. */
		error: text("error"),
		/** The persistent comment this review published to, when it published. */
		githubCommentId: text("github_comment_id"),
		/** PR head SHA reviewed, so history can be matched to a commit. */
		headSha: text("head_sha"),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index("reviews_repo_pr_idx").on(t.owner, t.repo, t.pr),
		index("reviews_status_idx").on(t.status),
		index("reviews_created_at_idx").on(t.createdAt),
	],
)

export const reviewQueueJobs = pgTable(
	"review_queue_jobs",
	{
		id: serial("id").primaryKey(),
		/** `owner/repo#pr` — the same dedupe key the in-memory queue uses. */
		key: text("key").notNull().unique(),
		owner: text("owner").notNull(),
		repo: text("repo").notNull(),
		pr: integer("pr").notNull(),
		state: text("state").$type<TQueueState>().notNull().default("pending"),
		/** Incremented per execution attempt. */
		attempts: integer("attempts").notNull().default(0),
		/** A webhook arrived while this job was running — coalesced re-run. */
		rerunRequested: boolean("rerun_requested").notNull().default(false),
		/** Earliest time this job may run; the scheduler's ordering key. */
		runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("review_queue_jobs_state_run_after_idx").on(t.state, t.runAfter)],
)

export type TReviewRow = typeof reviews.$inferSelect
export type TNewReviewRow = typeof reviews.$inferInsert
export type TReviewQueueJobRow = typeof reviewQueueJobs.$inferSelect
export type TNewReviewQueueJobRow = typeof reviewQueueJobs.$inferInsert

CREATE TABLE "review_queue_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"rerun_requested" boolean DEFAULT false NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_queue_jobs_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr" integer NOT NULL,
	"kind" text DEFAULT 'review' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"model" text,
	"markdown" text,
	"score" text,
	"error" text,
	"github_comment_id" text,
	"head_sha" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "review_queue_jobs_state_run_after_idx" ON "review_queue_jobs" USING btree ("state","run_after");--> statement-breakpoint
CREATE INDEX "reviews_repo_pr_idx" ON "reviews" USING btree ("owner","repo","pr");--> statement-breakpoint
CREATE INDEX "reviews_status_idx" ON "reviews" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reviews_created_at_idx" ON "reviews" USING btree ("created_at");
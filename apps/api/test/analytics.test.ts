// The analytics loop has to be closed END TO END, not just "a file was written".
//
// History: `notify-review.ts` wrote these records but nothing imported it, so on
// the server `pr_agent_requests_total` read 0 forever while reviews ran. Deleting
// the dead file removed the last writer without noticing. A guard that only
// asserted "recordReviewAnalytics is called" would let the same class of break
// back in, so these tests drive the real writer and then assert what the REAL
// reader (`generateMetrics` / `readAnalyticsLogs`) reports.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, test } from "vitest"
import { recordReviewAnalytics } from "../src/application/review/record-analytics.ts"
import { generateMetrics, readAnalyticsLogs } from "../src/infrastructure/analytics/jsonl.ts"

const target = { owner: "acme", repo: "widgets", pr: 42 }
let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pr-agent-analytics-"))
})

/** The counter value `generateMetrics` emits for one status. */
function counter(metrics: string, status: "success" | "failed"): number {
	const match = metrics.match(new RegExp(`pr_agent_requests_total\\{status="${status}"\\} (\\d+)`))
	expect(match, `no ${status} counter in:\n${metrics}`).not.toBeNull()
	return Number(match?.[1])
}

describe("a finished review reaches /api/metrics", () => {
	test("a success is counted as success, not as a failure", async () => {
		await recordReviewAnalytics({ analyticsDir: dir }, target, {
			status: "success",
			model: "claude-sonnet-5",
			promptTokens: 1200,
			completionTokens: 300,
			cachedTokens: 100,
			markdownLength: 2500,
		})

		const metrics = generateMetrics(dir)
		expect(counter(metrics, "success")).toBe(1)
		expect(counter(metrics, "failed")).toBe(0)
		expect(metrics).toContain('pr_agent_requests_by_command{command="review"} 1')
	})

	// The failure classification is a string contract: `generateMetrics` and
	// `/api/analytics` both key on "Failed to generate". Losing the prefix would
	// silently count every failure as a success — the counter would look healthy
	// during exactly the outage an operator is trying to detect.
	test("a failure is counted as failed and names the model", async () => {
		await recordReviewAnalytics({ analyticsDir: dir }, target, {
			status: "failed",
			error: "gateway timeout",
		})

		const metrics = generateMetrics(dir)
		expect(counter(metrics, "failed")).toBe(1)
		expect(counter(metrics, "success")).toBe(0)
	})

	test("/api/analytics sees the record with its PR context", async () => {
		await recordReviewAnalytics({ analyticsDir: dir }, target, {
			status: "success",
			model: "claude-sonnet-5",
			promptTokens: 10,
			completionTokens: 20,
			cachedTokens: 0,
			markdownLength: 30,
		})

		const records = readAnalyticsLogs(dir, 5)
		expect(records).toHaveLength(1)
		expect(records[0]?.extra?.command).toBe("review")
		expect(records[0]?.extra?.pr_url).toBe("https://api.github.com/repos/acme/widgets/pulls/42")
		expect(records[0]?.extra?.model).toBe("claude-sonnet-5")
	})

	test("a success also lands in the raw bun.jsonl feed", async () => {
		await recordReviewAnalytics({ analyticsDir: dir }, target, {
			status: "success",
			model: "claude-sonnet-5",
			promptTokens: 7,
			completionTokens: 8,
			cachedTokens: 9,
			markdownLength: 10,
		})

		expect(readdirSync(dir)).toContain("pr-agent.bun.jsonl")
		const rows = readFileSync(join(dir, "pr-agent.bun.jsonl"), "utf8").trim().split("\n")
		expect(rows).toHaveLength(1)
		const row = JSON.parse(rows[0] ?? "{}")
		expect(row).toMatchObject({ repo: "acme/widgets", pr: 42, command: "review", prompt_tokens: 7 })
	})

	// `runJob` awaits this before rethrowing the original review error. A
	// rejection here would replace that error with a bookkeeping one and send an
	// operator after the wrong cause.
	test("it never throws, even when the directory cannot be written", async () => {
		// A path UNDER A REGULAR FILE can never become a directory, so `mkdir`
		// fails here for real. (A plain nested path would not: mkdir -p succeeds.)
		const file = join(dir, "a-file")
		writeFileSync(file, "x")
		const unwritable = join(file, "nested")

		await expect(
			recordReviewAnalytics({ analyticsDir: unwritable }, target, {
				status: "failed",
				error: "boom",
			}),
		).resolves.toBeUndefined()
	})
})

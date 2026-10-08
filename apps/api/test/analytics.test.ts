import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
	appendAnalyticsEvent,
	generateMetrics,
	readAnalyticsLogs,
} from "../src/infrastructure/analytics/jsonl.ts"

function legacyLine(ts: number): string {
	return JSON.stringify({
		text: "",
		record: {
			time: { repr: new Date(ts).toISOString(), timestamp: ts / 1000 },
			level: { name: "INFO" },
			message: "Generated code suggestions",
			extra: { command: "review", model: "claude-opus-5" },
		},
	})
}

describe("analytics", () => {
	test("reads legacy pr-agent log lines and renders metrics", () => {
		const dir = mkdtempSync(join(tmpdir(), "pr-agent-test-"))
		writeFileSync(
			join(dir, "pr-agent.123.log"),
			[legacyLine(1000), legacyLine(2000)].join("\n") + "\n",
		)

		const records = readAnalyticsLogs(dir)
		expect(records.length).toBe(2)
		expect(records[0].message).toBe("Generated code suggestions")
		expect(records[0]._extra?.command).toBe("review")

		const metrics = generateMetrics(dir)
		expect(metrics).toContain('pr_agent_requests_total{status="success"} 2')
		expect(metrics).toContain('pr_agent_requests_by_command{command="review"} 2')
	})

	test("appendAnalyticsEvent round-trips through the same reader", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pr-agent-test-"))
		await appendAnalyticsEvent(dir, {
			message: "Generated code suggestions",
			extra: { command: "review", model: "claude-opus-5" },
		})

		const records = readAnalyticsLogs(dir)
		expect(records.length).toBe(1)
		expect(records[0].message).toBe("Generated code suggestions")
		expect(records[0]._extra?.command).toBe("review")
	})
})

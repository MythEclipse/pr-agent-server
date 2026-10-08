// Analytics HTTP surface: /api/metrics (Prometheus text) + /api/analytics (JSON).
// Returns null for any other path so the caller keeps routing.

import type { WebhookEnv } from "../../application/webhook/handle-webhook.ts"
import { generateMetrics, readAnalyticsLogs } from "../../infrastructure/analytics/jsonl.ts"

export function analyticsRoutes(url: URL, env: WebhookEnv): Response | null {
	if (url.pathname === "/api/metrics") {
		return new Response(generateMetrics(env.analyticsDir), {
			headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
		})
	}
	if (url.pathname === "/api/analytics") {
		const records = readAnalyticsLogs(env.analyticsDir, 5)
		const recent: Record<string, unknown>[] = []
		for (const rec of records.slice(-30)) {
			const extra = rec._extra ?? {}
			recent.push({
				time: rec.time?.repr ?? "",
				command: extra.command ?? "",
				message: rec.message ?? "",
				pr_url: extra.pr_url ?? "",
				model: extra.model ?? "",
				level: rec.level?.name ?? "",
			})
		}
		const failures = records.filter((r) => (r.message ?? "").includes("Failed to generate"))
		return Response.json({
			total_events: records.length,
			failure_count: failures.length,
			recent,
			failures: failures.slice(-20).map((r) => ({
				time: r.time?.repr ?? "",
				command: r._extra?.command ?? "",
				model: r._extra?.model ?? "",
				message: (r.message ?? "").slice(0, 200),
			})),
		})
	}
	return null
}

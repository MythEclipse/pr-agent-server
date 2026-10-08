// Analytics: legacy pr-agent JSONL reader, Prometheus metrics, and the async
// appenders. Reads the legacy pr-agent.*.log line format so /api/metrics and
// /api/analytics keep working across the Python → Bun cut-over.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

export interface AnalyticsRecord {
	text?: string
	record?: AnalyticsRecord
	message?: string
	time?: { repr?: string; timestamp?: number }
	level?: { name?: string }
	extra?: Record<string, unknown>
	_extra?: Record<string, unknown>
	_file?: string
}

export interface AnalyticsEvent {
	message: string
	extra: Record<string, unknown>
}

/** The raw per-review record appended to pr-agent.bun.jsonl. */
export interface BunAnalyticsRecord {
	time: string
	repo: string
	pr: number
	command: string
	model: string
	prompt_tokens: number
	completion_tokens: number
	cached_tokens: number
	markdown_len: number
}

/** Port of run_server._read_analytics_logs: parse pr-agent.*.log JSON lines
 *  (the legacy Python analytics format) so metrics/analytics endpoints keep
 *  working across the cut-over. Bun also writes its own events in the same
 *  shape (see appendAnalyticsEvent). */
export function readAnalyticsLogs(dir: string, maxFiles = 5): AnalyticsRecord[] {
	let files: string[] = []
	try {
		// sort by mtime DESC so the newest log files win (pid-based filenames are
		// not naturally ordered — e.g. 616504 vs 806320)
		files = readdirSync(dir)
			.filter((f: string) => f.endsWith(".log"))
			.sort((a: string, b: string) => {
				try {
					return statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs
				} catch {
					return 0
				}
			})
	} catch {
		return []
	}
	const records: AnalyticsRecord[] = []
	for (const f of files.slice(0, maxFiles)) {
		try {
			const content = readFileSync(join(dir, f), "utf8")
			for (const line of content.split("\n")) {
				const trimmed = line.trim()
				if (!trimmed) continue
				try {
					let rec = JSON.parse(trimmed) as AnalyticsRecord
					if (rec.record && typeof rec.record === "object") {
						rec = rec.record as AnalyticsRecord
					}
					const extra = (rec.extra ?? {}) as Record<string, unknown>
					if (extra.artifact && typeof extra.artifact === "object") {
						Object.assign(extra, extra.artifact)
						delete extra.artifact
					}
					rec._extra = extra
					rec._file = f
					records.push(rec)
				} catch {
					// skip malformed lines
				}
			}
		} catch {
			// skip unreadable files
		}
	}
	return records
}

export function generateMetrics(dir: string): string {
	const lines = [
		"# HELP pr_agent_requests_total Total PR-Agent analytics events",
		"# TYPE pr_agent_requests_total counter",
	]
	const records = readAnalyticsLogs(dir.trim(), 5)
	let failed = 0
	let success = 0
	const commandCounts: Record<string, number> = {}
	const modelFailures: Record<string, number> = {}
	for (const rec of records) {
		const extra = rec._extra ?? {}
		const cmd = (extra.command as string) ?? "unknown"
		commandCounts[cmd] = (commandCounts[cmd] ?? 0) + 1
		const msg = rec.message ?? ""
		if (
			msg.includes("Failed to generate") ||
			(msg.toLowerCase().includes("error") && rec.level?.name === "WARNING")
		) {
			failed++
			const model = (extra.model as string) ?? "unknown"
			modelFailures[model] = (modelFailures[model] ?? 0) + 1
		} else {
			success++
		}
	}
	lines.push(`pr_agent_requests_total{status="success"} ${success}`)
	lines.push(`pr_agent_requests_total{status="failed"} ${failed}`)
	lines.push("# HELP pr_agent_requests_by_command PR-Agent events by command")
	lines.push("# TYPE pr_agent_requests_by_command counter")
	for (const [cmd, cnt] of Object.entries(commandCounts).sort()) {
		lines.push(`pr_agent_requests_by_command{command="${cmd}"} ${cnt}`)
	}
	lines.push("# HELP pr_agent_model_failures PR-Agent model failures by model")
	lines.push("# TYPE pr_agent_model_failures counter")
	for (const [model, cnt] of Object.entries(modelFailures).sort()) {
		lines.push(`pr_agent_model_failures{model="${model}"} ${cnt}`)
	}
	return lines.join("\n") + "\n"
}

// ── writers ────────────────────────────────────────────────────────────────
// Every append is serialized through one module-level promise chain: concurrent
// review completions cannot interleave partial lines, and no caller ever blocks
// the event loop.

let chain: Promise<void> = Promise.resolve()

function enqueueWrite(write: () => Promise<void>): Promise<void> {
	chain = chain.then(write).catch(() => {})
	return chain
}

/** Append an analytics event in the legacy pr-agent JSONL shape so external
 *  dashboards that parse pr-agent.*.log keep working. */
export function appendAnalyticsEvent(dir: string, event: AnalyticsEvent): Promise<void> {
	if (!dir) return Promise.resolve()
	return enqueueWrite(async () => {
		try {
			await mkdir(dir, { recursive: true })
			const ts = new Date()
			const rec = {
				text: "",
				record: {
					time: { repr: ts.toISOString(), timestamp: ts.getTime() / 1000 },
					level: { name: "INFO" },
					message: event.message ?? "review done",
					extra: event.extra ?? {},
					_file: "",
				},
			}
			await appendFile(join(dir, `pr-agent.${process.pid}.log`), JSON.stringify(rec) + "\n")
		} catch {
			// analytics must never break the review path
		}
	})
}

/** Append a raw review record to pr-agent.bun.jsonl (the Bun-side feed). */
export function appendBunAnalyticsRecord(dir: string, record: BunAnalyticsRecord): Promise<void> {
	if (!dir) return Promise.resolve()
	return enqueueWrite(async () => {
		try {
			await mkdir(dir, { recursive: true })
			await appendFile(join(dir, "pr-agent.bun.jsonl"), JSON.stringify(record) + "\n")
		} catch {
			// analytics must never break the review path
		}
	})
}

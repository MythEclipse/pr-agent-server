/**
 * Buffered run report — port of `scripts/pr-queue-worker.py` lines 125-155
 * (`BUFFER` / `flush_log`).
 *
 * The worker buffers the whole tick's log lines and emits them once at the end:
 * to stdout when a human is watching (TTY), otherwise to the `pr-agent-ops`
 * Discord webhook so unattended cron runs stay out of the chat.
 *
 * NEVER throws and never rejects. The Python wraps the whole send path in a bare
 * `except Exception: pass`; a report is a nice-to-have and must not fail a tick.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_DESCRIPTION = 4000 // Python `report[:4000]`
const TIMEOUT_MS = 15_000 // Python `httpx.Client(timeout=15)`
const EMBED_COLOR = 0x5865f2 // Discord blurple

export class Report {
	private readonly buffer: string[] = []

	/** Append one line to the buffer. */
	push(line: string): void {
		this.buffer.push(line)
	}

	/**
	 * Emit and clear the buffer. Resolves even if delivery fails.
	 * Python does not clear `BUFFER`, but it is a one-shot process; clearing here
	 * is what makes a repeated per-tick flush post one report per tick instead of
	 * re-posting the whole history.
	 */
	async flush(): Promise<void> {
		const report = this.buffer.join("\n")
		this.buffer.length = 0
		if (!report) return // Python line 135-136

		try {
			if (process.stdin.isTTY) {
				console.log(report)
				return
			}
			// Python hardcodes ~/.hermes here (line 141). Resolved at CALL time via
			// HERMES_HOME (same precedence as env.ts) rather than the module-scope
			// `homedir()`, which Bun snapshots at process start and cannot be
			// redirected afterwards — that made this path untestable in isolation.
			const cfg = JSON.parse(
				readFileSync(
					join(process.env.HERMES_HOME ?? join(homedir(), ".hermes"), ".ops-webhooks.json"),
					"utf8",
				),
			) as Record<string, string | undefined>
			const url = cfg["pr-agent-ops"]
			if (!url) return
			await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					username: "PR-Agent Ops",
					embeds: [
						{
							title: "🔀 PR Queue Worker Report",
							description: report.slice(0, MAX_DESCRIPTION),
							color: EMBED_COLOR,
						},
					],
				}),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			})
		} catch {
			/* never raises, never blocks the tick */
		}
	}
}

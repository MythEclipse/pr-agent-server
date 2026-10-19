/**
 * Vitest global setup — run once, BEFORE any test module is imported.
 *
 * Two jobs, both of which exist because of the 2026-10-19 `#notif` spam
 * incident (120 embeds whose content was `t` / `l`, posted by this suite):
 *
 *  1. STRIP every live-notification environment variable. The worker reads
 *     `DISCORD_WEBHOOK_URL` as a fallback for the ops webhook, and the AI-fix
 *     agent runs `pnpm test` with the production environment inherited. A test
 *     that only redirects `HERMES_HOME` is hermetic against the CONFIG FILE and
 *     blind to the env var, so an "unconfigured → do not send" assertion really
 *     posted to the live channel.
 *
 *  2. REFUSE non-loopback network egress. The strip is the fix; the guard is
 *     what makes a regression LOUD. Without it, a reintroduced env variable is
 *     silently swallowed (every notifier catches fetch errors by contract) and
 *     the leak returns with a green build.
 *
 * Both live here rather than in an individual test file because a `beforeEach`
 * in one file cannot protect another, and because `setupFiles` is the only hook
 * that runs before the first module-level `process.env` read.
 */
import { afterAll, beforeEach } from "vitest"
import { installEgressGuard } from "./helpers/hermetic.ts"

/**
 * Notification variables that must never reach a test.
 *
 * Named individually rather than glob-matched on `*WEBHOOK*`: the worker and the
 * API also need GITHUB_WEBHOOK_SECRET/PR_AGENT_WEBHOOK_SECRET, and blanking
 * those would break signature tests for a reason unrelated to this guard.
 */
const LIVE_ENV_VARS = [
	"DISCORD_WEBHOOK_URL",
	"DISCORD_ALERT_WEBHOOK_URL",
	"PR_AGENT_NOTIFY_URL",
] as const

/**
 * Captured so a later re-set is detectable, and cleared again in `beforeEach`:
 * one test file setting a value must not make the next file leak, and the whole
 * point of this file is that the default is "no live URL anywhere".
 */
function stripLiveEnv(): void {
	for (const key of LIVE_ENV_VARS) delete process.env[key]
}

stripLiveEnv()
const blocked = installEgressGuard()

beforeEach(stripLiveEnv)

/**
 * A refused request that no test claimed is a LEAK, and fails the run.
 *
 * The distinction matters: a test may legitimately prove the guard blocks
 * something (it asserts the entry and then clears the array). Anything left over
 * is an unexamined attempt to reach the network — the exact behaviour that
 * produced 120 junk posts — so it is reported with the URL, and the run fails
 * rather than passing on a swallowed error.
 */
afterAll(() => {
	if (blocked.length === 0) return
	const list = blocked.map((b) => `  - ${b.url}`).join("\n")
	throw new Error(
		`test egress guard: ${blocked.length} non-loopback request(s) were attempted and blocked.\n` +
			`A test tried to reach the real network; this is the shape of the 2026-10-19 Discord spam bug.\n${list}`,
	)
})

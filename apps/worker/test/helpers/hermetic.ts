/**
 * Test-only egress guard and environment hardening.
 *
 * WHY THIS EXISTS. On 2026-10-19 the `#notif` channel received 120 junk embeds
 * whose entire content was `t` / `l`. Those are the literals in
 * `discord.test.ts` — `postDiscordOps("t", ["l"])` — so the worker's own test
 * suite was posting to the live channel. Three facts combined to allow it:
 *
 *   1. `opsWebhookUrl()` has TWO sources: `$HERMES_HOME/.ops-webhooks.json` and
 *      `DISCORD_WEBHOOK_URL`. The tests redirect only the first (HERMES_HOME is
 *      pointed at a temp dir), so the second still held the live URL.
 *   2. Every leaking test asserts "when no URL is configured, do not send" and
 *      cleared the CONFIG FILE, never the environment variable. With the env
 *      set, `opsWebhookUrl()` returned the live webhook and the send happened.
 *   3. The tests were run by the AI-fix agent, which inherits the worker's full
 *      `process.env` via `buildEnv`'s `...process.env` and runs `pnpm test`
 *      inside the PR worktree to check its own work.
 *
 * The strip below is the ROOT fix: a test run can never inherit a real webhook
 * from the host environment, so "unconfigured" means unconfigured again.
 *
 * The guard is the second half, and it exists because the strip alone is
 * invisible when it regresses. If someone re-introduces the env variable, a
 * blocked send returns `false` exactly like a configured one would, so the test
 * still passes and the leak is silent again — the same shape as the three
 * `sweepStale` guards that read as protection while the case they named went
 * unhandled. So a blocked attempt is RECORDED, and the setup file FAILS the
 * test file that made it. A regression becomes a red build, never a quiet post.
 */

/** Hosts a test may legitimately reach: loopback stubs only. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

/** One refused request: the URL that was attempted. */
export interface BlockedEgress {
	url: string
}

/**
 * Replace `globalThis.fetch` with a version that refuses every non-loopback
 * URL, and return the live list of refused attempts.
 *
 * The returned array is mutable on purpose: a test that exercises the guard
 * itself asserts its entry and then clears it, so the setup file's `afterAll`
 * check reports only unclaimed leaks.
 *
 * A refused request REJECTS rather than resolving a synthetic response. Callers
 * under test (`notifyReview`, `postDiscordOps`, `Report.flush`) all swallow
 * fetch failures by contract, so a rejection is behaviourally identical to the
 * network being down — which is exactly what a test that reaches this path is
 * pretending. It also cannot be mistaken for a delivered message.
 *
 * Loopback stays allowed because the suites bind real `node:http` stubs on
 * `127.0.0.1:0` and the whole point of those tests is to exercise the real
 * fetch path against them.
 */
export function installEgressGuard(): BlockedEgress[] {
	const blocked: BlockedEgress[] = []
	const realFetch = globalThis.fetch

	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url
		if (!isLoopback(url)) {
			blocked.push({ url })
			return Promise.reject(
				new Error(
					`test egress guard: refused a non-loopback request to ${url}. ` +
						"A test must not reach the network — point it at a loopback stub, " +
						"or clear the environment variable that supplied the URL.",
				),
			)
		}
		// The cast is unavoidable: the narrowed union above is what a stub caller
		// actually passes, while `fetch` is typed against the DOM's `RequestInfo`,
		// which this tsconfig's lib set does not expose by name.
		return realFetch(input as Parameters<typeof realFetch>[0], init)
	}) as typeof fetch

	return blocked
}

/** True only for a URL that resolves to this machine. */
function isLoopback(rawUrl: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(rawUrl).hostname)
	} catch {
		// An unparseable URL is not a loopback one. Refusing it is the safe
		// direction: the alternative is letting a malformed string through to the
		// real fetch, which is the case this guard exists to stop.
		return false
	}
}

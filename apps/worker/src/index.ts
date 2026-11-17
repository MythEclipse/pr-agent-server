/**
 * Worker entry point + CLI — the port of the Python's
 * `if __name__ == "__main__":` block (lines 2189-2224) and its construction of
 * the global collaborators, which lived at module scope in the Python.
 *
 * `bootstrapEnv()` MUST stay the first statement: PATH and the `PR_AGENT_*`
 * secrets have to be in place before anything reads config. The Python did this
 * at IMPORT time, before its config constants resolved, and ES module imports
 * hoist, so the guarantee has to be made explicitly. It is deliberately NOT
 * inside `runTick` — the brief puts it there, but the Python and env.ts's
 * call-order note both put it at the entry point, and the entry point is where
 * it can be first. (Noted in the task-14 report.)
 *
 * THE SIGTERM HANDLER IS NOT OPTIONAL. The Python installs `_term_handler`
 * (2194-2198) so a cron `kill` releases the lockfile instead of leaving it to
 * be recycled by a PID-liveness check on the next tick. `runTick` reports its
 * lock through `onLockAcquired`; without that seam the handler has nothing to
 * release, and a stale lock wedges every later tick.
 */
import { bootstrapEnv } from "./env.ts"
import { spawnSyncCompat } from "./lib/proc.ts"

bootstrapEnv()

import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { AgentClient } from "./claude-agent.ts"
import type { WorkerCliContext } from "./cli/context.ts"
import { maintain } from "./cli/maintain.ts"
import { syncHooks, syncOnly } from "./cli/sync.ts"
import { auditVulns, fixVulns } from "./cli/vulns.ts"
import { notifyReview, postDiscordOps } from "./discord.ts"
import { runGit } from "./git.ts"
import { GitHubApi } from "./github.ts"
import { WorkerLock } from "./lock.ts"
import { guardDisk, nodeDiskDeps } from "./ops/diskGuard.ts"
import { nodeProcessDeps } from "./pr/autofix.ts"
import { registryFetchFrom } from "./pr/bump-guard.ts"
import { nodeWorkdirs, type ProcRunner } from "./pr/lockfix.ts"
import { runTick, type WorkerDeps } from "./pr/pipeline.ts"
import { Report } from "./report.ts"
import { FIX_STATE_FILE, loadFixState, loadSyncState, saveFixState } from "./state.ts"
import { fileSyncState, skipRepoOverrides } from "./sync/run.ts"

// Preserve the existing public seam used by CLI exit-code tests.
export { syncHooksExitCode } from "./cli/sync.ts"

// ── Config, all read at CALL time (Python lines 59-62) ──────────────────────

/** Python `APP_ID` (line 59) — a dev default, never a secret. */
const APP_ID = process.env.PR_AGENT_APP_ID || "4319749"
/** Python `PRIVATE_KEY_PATH` (line 60). */
const KEY_PATH = process.env.PR_AGENT_KEY_PATH || "/home/code/.hermes/keys/pr-agent-key.pem"
/** Python `WEBHOOK_SECRET` (line 61) — empty means signing with the empty key. */
const WEBHOOK_SECRET = process.env.PR_AGENT_WEBHOOK_SECRET || ""
/** Python `PR_AGENT_WEBHOOK_URL` (line 62). */
const WEBHOOK_URL =
	process.env.PR_AGENT_WEBHOOK_URL || "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks"

/**
 * `GITHUB_WEBHOOK_SECRET` for the fork-config sync (Task 16). Read here, in the
 * one module allowed to touch the environment, and handed to `runSyncHooks` as
 * an explicit dep so the ops module never has to reach for `process.env`
 * itself. Empty is meaningful: it makes the webhook step skip entirely, leaving
 * the Dependabot files to be synced on their own.
 */
const OPS_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || ""

/**
 * How long the bump guard may wait on the npm registry, per package.
 *
 * SHORT ON PURPOSE. This runs inside a tick that also holds the worker lock, and
 * the guard is an optimisation: a registry that is slow is a registry we treat
 * as "could not tell", which passes the bump and falls back to the previous
 * behaviour. There is no version of this where waiting longer is better than
 * letting the PR through.
 */
const REGISTRY_TIMEOUT_MS = 5000

/**
 * Whether the daily fork-config sync runs. OPT-IN, and it stays that way until
 * someone has read `apps/worker/src/ops/templates/` and agreed with what it writes.
 *
 * Those templates are the one genuinely greenfield artefact in this migration:
 * the Python they replace was already gone, so nothing states what fleet-wide
 * Dependabot config the previous operator wanted. Turning this on is a config
 * decision with fleet-wide consequences, not a code change, so it is gated
 * rather than defaulted. Set it to a truthy value to enable.
 */
const SYNC_HOOKS = process.env.PR_AGENT_SYNC_HOOKS === "1"

// ── The collaborators the Python held as module globals ─────────────────────

/**
 * The `ProcRunner` port: run a non-git command, never throwing.
 *
 * `runGit` is the wrong port here — it prefixes every argv with `git`, which
 * would turn `uv lock` into `git uv lock`. The Python's equivalent is
 * `subprocess.run(args, capture_output=True, text=True, timeout=N)`, and its
 * failure modes are the ones the callers branch on: a non-zero exit (`uv lock`
 * failed) and a missing binary (127). Both are reported, never thrown, and
 * `exitedDueToTimeout` maps to the Python's `TimeoutExpired` → 124, the same
 * exit code `git.ts` uses.
 */
const runProc: ProcRunner = (args, cwd, timeoutSec = 180) => {
	try {
		const r = spawnSyncCompat(args.map(String), {
			cwd: cwd ? String(cwd) : undefined,
			timeout: timeoutSec * 1000,
		})
		if (r.exitedDueToTimeout) {
			return { code: 124, stdout: "", stderr: `timeout after ${timeoutSec}s` }
		}
		return {
			code: r.code,
			stdout: r.stdout,
			stderr: r.stderr,
		}
	} catch (err) {
		const e = err as NodeJS.ErrnoException
		return { code: e.code === "ENOENT" ? 127 : 1, stdout: "", stderr: String(e.message ?? err) }
	}
}

/**
 * Build the real deps from the environment.
 *
 * The Python constructed these at import time, where a missing private key
 * raises immediately (line 161: `PRIVATE_KEY_PATH.read_text()`). That is
 * reproduced here rather than softened: an empty `privateKeyPem` does NOT
 * degrade into "no PRs", it throws out of `crypto.sign` deep inside the first
 * `request`, which reads as a crash in the wrong place. Failing at the read,
 * with the path in the message, is both what the Python does and the cheaper
 * failure to debug.
 *
 * It is a FUNCTION rather than module scope so that `--sync-status` — a
 * read-only JSON dump of a local file that needs no credential at all — cannot
 * fail because the key is absent. That is the one place the Python's
 * import-time construction is genuinely inconvenient.
 */
function buildDeps(opts: { dry: boolean; report: Report }): WorkerDeps {
	// The key is the one thing that cannot be faked, so read it with a message
	// an operator can act on. A bare `readFileSync` here surfaced as a raw ENOENT
	// stack pointing at `readFileSync`, which reads like a bug in the worker
	// rather than a missing deployment credential. Every other external effect
	// below is a function or a client and fails on use; only this one is read
	// eagerly, so only this one needs the guard.
	let privateKeyPem: string
	try {
		privateKeyPem = readFileSync(KEY_PATH, "utf8")
	} catch {
		throw new Error(
			`GitHub App private key not found at ${KEY_PATH}. Set PR_AGENT_KEY_PATH ` +
				`(and PR_AGENT_APP_ID), or run --sync-status, which needs no credential.`,
		)
	}
	const api = new GitHubApi({
		appId: APP_ID,
		privateKeyPem, // Python line 161
	})
	const workdirs = nodeWorkdirs()
	const syncState = fileSyncState()
	return {
		api,
		agent: new AgentClient(),
		run: runGit,
		exec: runProc,
		workdirs,
		procs: nodeProcessDeps(workdirs),
		fetchGhToken: () => api.fetchGhToken(),
		report: opts.report,
		flushReport: () => opts.report.flush(),
		notify: notifyReview,
		postDiscord: postDiscordOps,
		loadFixState: () => loadFixState(),
		saveFixState: (state) => saveFixState(FIX_STATE_FILE, state),
		loadSyncState: () => syncState.load(),
		saveSyncState: (state) => syncState.save(state),
		repoOverrides: skipRepoOverrides(),
		now: () => Date.now() / 1000,
		fetchImpl: (input, init) => fetch(input, init as RequestInit),
		// The unshippable-bump guard's registry read. Wired here, in the one module
		// allowed to touch the network stack directly, so `pr/bump-guard.ts` stays
		// injectable and testable without a socket.
		fetchRegistry: registryFetchFrom(async (url) => {
			const res = await fetch(url, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
			})
			return { status: res.status, text: () => res.text() }
		}),
		lock: { acquire: (path) => WorkerLock.acquire(path) },
		webhookSecret: WEBHOOK_SECRET,
		webhookUrl: WEBHOOK_URL,
		dry: opts.dry,
	}
}

// ── SIGTERM ─────────────────────────────────────────────────────────────────

/**
 * Python `_term_handler` (2194-2198): release the lock, then exit `128+signum`.
 *
 * The handler is registered ONCE and reads a module-level slot rather than a
 * closure per mode, so the `--sync-only` and `runTick` paths share it.
 *
 * `process.exit` is what makes this correct rather than merely adequate: it
 * does NOT unwind `try`/`finally`, so the Python's `SystemExit` → `finally` →
 * `release_lock()` chain has to be reproduced by hand here. Every path that
 * takes the lock also clears the slot, so a second SIGTERM cannot re-enter a
 * release that already happened, and a release is idempotent anyway
 * (`unlinkSync` on a missing path is a no-op).
 */
let releaseHeld: (() => void) | null = null
process.on("SIGTERM", () => {
	releaseHeld?.()
	releaseHeld = null
	process.exit(143) // 128 + 15
})

const cliContext: WorkerCliContext = {
	buildDeps,
	webhookSecret: OPS_WEBHOOK_SECRET,
	setReleaseHeld(release) {
		releaseHeld = release
	},
}

// ── main ───────────────────────────────────────────────────────────────────

/**
 * Dispatch CLI modes in precedence order; run the queue tick when none is selected.
 * `--sync-status` wins over all other modes.
 *
 * `--sync-status` deliberately takes NO lock and touches no network: it is the
 * read-only mode, and it has to stay answerable while a tick is running, which
 * is exactly when an operator most wants to ask it.
 */
/**
 * Test seam for argument parsing and mode gates without invoking the entry point.
 *
 * Named to be obvious at every call site that this is not an internal API.
 */
export async function runCliForTest(argv: string[]): Promise<number> {
	return main(argv)
}

async function main(argvIn?: string[]): Promise<number> {
	const argv = argvIn ?? process.argv.slice(2)
	if (argv.includes("--sync-status")) {
		console.log(JSON.stringify(loadSyncState(), null, 2))
		return 0
	}
	if (argv.includes("--sync-only")) return syncOnly(argv, cliContext)
	if (argv.includes("--sync-hooks")) {
		if (!SYNC_HOOKS) {
			console.error(
				"pr-queue-worker: --sync-hooks is gated. Set PR_AGENT_SYNC_HOOKS=1 after " +
					"reviewing apps/worker/src/ops/templates/ — it rewrites Dependabot config " +
					"across every repo this token can see.",
			)
			return 1
		}
		return syncHooks(argv, cliContext)
	}
	if (argv.includes("--fix-vulns")) {
		// Gated inside `fixVulns` — it writes fleet-wide config, so it needs the
		// same review-before-you-run gate as `--sync-hooks`.
		return fixVulns(argv, cliContext)
	}
	if (argv.includes("--scan-vulns")) {
		// Read-only: no gate. An audit that requires a write flag is an audit
		// nobody runs.
		return auditVulns(argv, cliContext)
	}
	if (
		argv.includes("--maintain") ||
		argv.includes("--enforce-settings") ||
		argv.includes("--hygiene") ||
		argv.includes("--triage")
	) {
		// The housekeeping pass: disk guard, security-settings enforcement, branch
		// hygiene, CI triage. `--dry` reports without writing.
		return maintain(argv, cliContext)
	}

	// THE DISK GUARD RUNS ON EVERY TICK, and it is cheap: one `statfs`, and the
	// reaper only wakes above the threshold. The tick clones repos too, so a guard
	// that only ran in the nightly modes would miss the path that actually fills
	// the disk — a busy queue is exactly when the clones pile up.
	const tickDisk = guardDisk(
		nodeDiskDeps((a) => runProc(a, undefined, 600), console.log),
		{
			base: process.env.PR_AGENT_WORK_DIR || "/tmp/pr-queue-work",
		},
	)
	if (tickDisk.removed > 0) {
		console.log(
			`pr-queue-worker: disk ${tickDisk.usedPctBefore}% → ${tickDisk.usedPctAfter}% (${tickDisk.removed} workdir(s) reaped)`,
		)
	}
	if (tickDisk.refuse) {
		console.error("pr-queue-worker: skipping this tick — disk is too full to clone")
		return 1
	}

	const report = new Report()
	await runTick({
		...buildDeps({ dry: argv.includes("--dry"), report }),
		onLockAcquired: (release) => {
			releaseHeld = release
		},
	})
	// `runTick` released the lock in its own `finally`; drop the stale handle so a
	// later SIGTERM cannot unlink a lockfile some LATER process now owns.
	releaseHeld = null
	return 0
}

// Only run when executed as the program. Without this guard every test that
// imports the CLI — which the `--sync-hooks` gate tests must do to reach `main`
// — would fire a real tick, take the real lock and touch the real API.
//
// `import.meta.main` was the Bun spelling; Node asks the same question by
// comparing argv[1] with this module's resolved path.
function isEntrypoint(): boolean {
	const entry = process.argv[1]
	if (!entry) return false
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
	} catch {
		return false
	}
}

if (isEntrypoint()) {
	try {
		process.exitCode = await main()
	} catch (err) {
		// A missing credential is an operator-actionable configuration error, not a
		// crash: report it as one line on stderr with a non-zero exit, instead of a
		// stack trace that buries the cause. Anything else is a real defect and keeps
		// its stack for debugging.
		const message = err instanceof Error ? err.message : String(err)
		if (message.includes("private key not found")) {
			console.error(`pr-queue-worker: ${message}`)
			process.exitCode = 1
		} else {
			throw err
		}
	}
}

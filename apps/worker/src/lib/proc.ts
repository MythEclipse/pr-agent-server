// Node replacement for Bun.spawnSync.
//
// The worker shells out constantly (git, gh CLI, and the deploy probe), and
// the call sites depend on Bun's exact result shape: `exitedDueToTimeout` for
// a killed child, piped stdout/stderr as strings, and a *thrown* ENOENT when
// the binary is missing. Node's spawnSync reports a timeout through
// `error.code === "ETIMEDOUT"` and a missing binary through ENOENT, so both
// are translated back into the Bun shape rather than changing every call site.

import { type SpawnSyncReturns, spawnSync } from "node:child_process"

export interface ProcResult {
	/** Exit code, or the Python-parity sentinel 124 when the timeout fires. */
	code: number
	stdout: string
	stderr: string
	/** True when the child was killed for exceeding its timeout budget. */
	exitedDueToTimeout: boolean
}

export interface SpawnOptions {
	cwd?: string
	/** Milliseconds before the child is killed. */
	timeout?: number
	env?: Record<string, string | undefined>
}

function isTimeout(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ETIMEDOUT"
	)
}

/** Signal name -> number, for reporting a signalled death as `128 + n`. */
const SIGNALS: Record<string, number> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGILL: 4,
	SIGTRAP: 5,
	SIGABRT: 6,
	SIGBUS: 7,
	SIGFPE: 8,
	SIGKILL: 9,
	SIGUSR1: 10,
	SIGSEGV: 11,
	SIGUSR2: 12,
	SIGPIPE: 13,
	SIGALRM: 14,
	SIGTERM: 15,
}

/**
 * Spawn a command synchronously and normalise Node's result into the shape the
 * worker already consumes. Throws when the binary does not exist, matching
 * Bun.spawnSync — `git.test.ts` asserts that ENOENT propagates.
 */
export function spawnSyncCompat(cmd: readonly string[], options: SpawnOptions = {}): ProcResult {
	const [file, ...args] = cmd
	if (file === undefined) {
		throw new Error("spawnSyncCompat requires at least a command")
	}

	const result: SpawnSyncReturns<string> = spawnSync(file, args, {
		cwd: options.cwd,
		timeout: options.timeout,
		env: options.env as NodeJS.ProcessEnv | undefined,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})

	if (result.error) {
		if (isTimeout(result.error)) {
			return { code: 124, stdout: "", stderr: "", exitedDueToTimeout: true }
		}
		// A missing binary must propagate, exactly as Bun.spawnSync threw.
		throw result.error
	}

	// A CHILD KILLED BY A SIGNAL HAS `status === null`.
	//
	// The old `status ?? 1` reported that as exit 1 — indistinguishable from the
	// child choosing to fail, and therefore pinnable as a permanent agent failure.
	// It is not: something outside the process ended it. Reporting `128 + signum`
	// keeps the signal visible (143 = SIGTERM, 137 = SIGKILL) so the classifier in
	// `pr/context.ts` can tell a kill from a verdict.
	if (result.status === null) {
		const signum = result.signal ? (SIGNALS[result.signal] ?? 0) : 0
		return {
			// 128 + n is the shell convention; 1 remains the fallback for the
			// impossible case of a null status with no signal.
			code: signum > 0 ? 128 + signum : 1,
			stdout: result.stdout ?? "",
			stderr: `${result.stderr ?? ""}${result.signal ? `[killed by ${result.signal}]` : ""}`,
			// A kill is NOT a timeout: `exitedDueToTimeout` drives the "timed out
			// after Ns" message, and claiming a timeout that did not happen would
			// misattribute an operator's restart to our own budget.
			exitedDueToTimeout: false,
		}
	}

	return {
		code: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		exitedDueToTimeout: false,
	}
}

// Node replacement for Bun.spawnSync.
//
// The worker shells out constantly (git, gh CLI, and the deploy probe), and
// the call sites depend on Bun's exact result shape: `exitedDueToTimeout` for
// a killed child, piped stdout/stderr as strings, and a *thrown* ENOENT when
// the binary is missing. Node's spawnSync reports a timeout through
// `error.code === "ETIMEDOUT"` and a missing binary through ENOENT, so both
// are translated back into the Bun shape rather than changing every call site.

import { spawnSync, type SpawnSyncReturns } from "node:child_process"

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

	return {
		code: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		exitedDueToTimeout: false,
	}
}
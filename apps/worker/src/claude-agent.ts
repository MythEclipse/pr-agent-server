// biome-ignore-all lint/suspicious/noExplicitAny: the agent's own output is untyped text
/**
 * Claude Code CLI agent — the AI-fix and upstream-sync engine.
 *
 * MIGRATED FROM THE HERMES GATEWAY (2026-10-13). This used to POST to
 * `127.0.0.1:8642/v1/chat/completions` and lean on the gateway for the provider
 * config and the whole toolset. It now spawns the Claude Code binary directly,
 * which removes the gateway from the AI-fix path entirely.
 *
 * WHY THE CLI RATHER THAN THE GATEWAY
 * - No hidden dependency on a long-running gateway that can be down, restarted,
 *   or misconfigured independently of the worker. The gateway answering 200 with
 *   "Unknown provider" inside `content` is exactly what silently disabled
 *   auto-fix before.
 * - The turn cap, the toolset and the working directory become explicit argv
 *   rather than server-side config the worker cannot see.
 *
 * THE TWO INVARIANTS THIS FILE EXISTS TO KEEP
 *
 * 1. IT MUST NOT RUN AS ROOT. Claude Code refuses
 *    `--dangerously-skip-permissions` under root/sudo ("cannot be used with
 *    root/sudo privileges for security reasons"), and it is right to: the whole
 *    point of that flag is that the agent runs unattended with no prompts. The
 *    worker unit is `User=pr-agent` for exactly this reason — do not "simplify"
 *    it to root. `assertNotRoot` turns a root regression into a clear failure
 *    instead of a puzzling refusal from the CLI.
 *
 * 2. THE AGENT MUST NOT PUSH. The worker validates the agent's commits and
 *    pushes them itself, so a pushing agent can put unvalidated code on a branch.
 *    That boundary lives in the prompt (`buildAiFixPrompt`) and is enforced by
 *    `runAiFix` refusing to trust the agent's own claim.
 *
 * NON-INTERACTIVE BY CONSTRUCTION: `-p/--print` reads the prompt from argv and
 * exits, `--output-format text` keeps stdout parseable, and
 * `--dangerously-skip-permissions` removes every prompt that would otherwise
 * hang the tick forever. There is no TTY and no stdin: a tick that waits for a
 * human is a tick that never finishes.
 */
import { accessSync, constants, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { type ProcResult, spawnSyncCompat } from "./lib/proc.ts"

/** Where the Claude Code binary is expected, in priority order. */
export const CLAUDE_BIN_CANDIDATES = [
	"/usr/local/bin/claude",
	"/usr/bin/claude",
	"/home/code/.local/bin/claude",
] as const

/**
 * The Anthropic-compatible endpoint Claude Code talks to.
 *
 * Claude Code speaks the Anthropic Messages API, so it needs a base URL, not the
 * OpenAI-shaped `{base}/v1` the review tool uses. Overridable per install.
 */
export const DEFAULT_ANTHROPIC_BASE_URL = "https://9router.asepharyana.my.id"

/**
 * The model. Overridable with `PR_AGENT_CLAUDE_MODEL` so a different install
 * (or a cheaper fix pass) does not need a rebuild.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5"

/** Python `AI_FIX_MAX_TURNS` (line 75) — the gateway's turn cap, now ours. */
export const AI_FIX_MAX_TURNS = 100

/** Python `SYNC_CLAUDE_TIMEOUT` (line 988) — conflict resolution + verification. */
export const SYNC_CLAUDE_TIMEOUT = 3600

/** Python `AI_FIX_TIMEOUT` (line 76) — seconds per PR, tools included. */
export const AI_FIX_TIMEOUT = 1800

/** Reported, never enforced here (the port kept it that way). */
export const SNIPPET_TAIL = 400
const DETAIL_HEAD = 300

/**
 * Ruling 5: byte-exact. This string tells the agent it is in a PR worktree and
 * that it must not push. It is asserted as a literal in the tests rather than
 * compared against a constant, which would be a tautology.
 */
export const AGENT_SYSTEM_PROMPT =
	"You are an autonomous coding agent inside a git worktree. Use your terminal and file tools to complete the task. Work ONLY inside the current working directory. Do NOT push."

export interface PostOptions {
	/** The git worktree the agent may edit. Also the CLI's cwd. */
	workdir?: string
	/** Audit filename stem: `<label>.prompt.txt` is written beside the workdir. */
	label?: string
	timeoutSec?: number
	/** Continues a prior transcript (upstream sync). Unused by the CLI. */
	sessionId?: string
}

export interface PostResult {
	ok: boolean
	/** Tail of the agent's output, for the report. Never contains a credential. */
	snippet: string
}

/** What `AgentClient` needs from the outside world, so tests stay hermetic. */
export type Spawner = (
	argv: string[],
	opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
) => ProcResult

/** The default spawner: the real binary, bounded, never throwing. */
const defaultSpawn: Spawner = (argv, opts) =>
	spawnSyncCompat(argv, { cwd: opts.cwd, timeout: opts.timeoutMs, env: opts.env })

export type AgentClientOptions = {
	/** Explicit binary path; otherwise the first candidate that exists. */
	bin?: string
	spawn?: Spawner
	timeoutSec?: number
	/** Bound on the agent's own tool loop. */
	maxTurns?: number
	model?: string
	baseUrl?: string
	/** Injection seam for the root guard, so the rule is testable. */
	isRoot?: () => boolean
}

/**
 * Root is refused by Claude Code, so fail here with a message that names the
 * cause instead of letting the CLI print a security notice the operator has to
 * decode. `isRoot` is injected so this is testable.
 */
function assertNotRoot(isRoot: boolean): void {
	if (isRoot) {
		throw new Error(
			"Claude Code refuses --dangerously-skip-permissions as root. " +
				"Run the worker as a non-root user (the unit is User=pr-agent); " +
				"do not work around this by dropping the flag.",
		)
	}
}

/**
 * The environment the CLI needs.
 *
 * `ANTHROPIC_API_KEY` is cleared ON PURPOSE. The credential arrives as
 * `ANTHROPIC_AUTH_TOKEN` from Bitwarden via `bws-exec`, and Claude Code prefers
 * `ANTHROPIC_API_KEY` when both are set — a stale key there silently wins and
 * every run fails auth. Blanking it is what makes the vault value authoritative.
 *
 * `SHELL=/bin/sh` matters: `pr-agent`'s passwd shell is `/usr/sbin/nologin`, and
 * the agent's Bash tool spawns `$SHELL`, so without this every command exits 1
 * with no output and the agent concludes it cannot do anything.
 *
 * The `PATH` is explicit and minimal. Cron gives a scrubbed environment where
 * `git` is not on the PATH, and the agent's whole task is git.
 */
function buildEnv(opts: {
	baseUrl: string
	model: string
	extra: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...opts.extra,
		PATH: "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
		HOME: process.env.HOME || "/var/lib/pr-agent-server",
		SHELL: "/bin/sh",
		// Non-interactive: never prompt, never page, never colour-code.
		CI: "1",
		NO_COLOR: "1",
		TERM: "dumb",
		ANTHROPIC_BASE_URL: opts.baseUrl,
		ANTHROPIC_MODEL: opts.model,
		ANTHROPIC_API_KEY: "",
	}
	// Strip any inherited Claude Code session/config pointers so a tick never
	// inherits a developer's interactive session or resumes a stale transcript.
	delete env.CLAUDE_CODE_SESSION
	delete env.CLAUDE_CONFIG_DIR
	return env
}

export class AgentClient {
	private readonly bin: string | undefined
	private readonly spawn: Spawner
	private readonly timeoutSec: number
	private readonly maxTurns: number
	private readonly model: string
	private readonly baseUrl: string
	/** Injected for the root guard; defaults to the real uid check. */
	private readonly isRoot: () => boolean

	constructor(opts: AgentClientOptions = {}) {
		this.bin = opts.bin
		this.spawn = opts.spawn ?? defaultSpawn
		this.timeoutSec = opts.timeoutSec ?? SYNC_CLAUDE_TIMEOUT
		this.maxTurns = opts.maxTurns ?? AI_FIX_MAX_TURNS
		this.model = opts.model ?? process.env.PR_AGENT_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL
		this.baseUrl = opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL
		this.isRoot =
			opts.isRoot ?? (() => typeof process.getuid === "function" && process.getuid() === 0)
	}

	/**
	 * Upstream-sync entry point — the same CLI run, tagged with the fork it is
	 * reconciling.
	 *
	 * The CLI has no notion of a "session" to continue, so this is `post` plus the
	 * `fork` label that the audit file and the report key off. Keeping it a
	 * separate method (rather than widening `PostOptions`) preserves the shape
	 * `sync/types.ts` declares and keeps the two call sites' contracts distinct.
	 */
	async runSync(opts: {
		workdir: string
		prompt: string
		label: string
		fork: string
		dry?: boolean
	}): Promise<PostResult> {
		return this.post(opts.prompt, {
			workdir: opts.workdir,
			label: opts.label,
			// Conflict resolution across a whole upstream history is the long pole,
			// so it gets the sync budget rather than the per-PR fix budget.
			timeoutSec: SYNC_CLAUDE_TIMEOUT,
		})
	}

	/**
	 * Run one agent turn to completion. Never throws: a cron tick must degrade,
	 * not crash, and every caller branches on `ok`.
	 */
	async post(prompt: string, opts: PostOptions = {}): Promise<PostResult> {
		const workdir = opts.workdir ?? process.cwd()
		const timeout = opts.timeoutSec ?? this.timeoutSec

		if (opts.workdir && opts.label) {
			// The prompt is written to disk so a failed run can be replayed by hand
			// with the exact same instructions.
			//
			// OUTSIDE the worktree, and this is load-bearing. `workdir` is the git
			// clone of the PR branch, and the prompt is written BEFORE the agent
			// runs — so the agent then sees an untracked `claude_pr_<n>.prompt.txt`
			// sitting in its working directory, and its own instruction is
			// `git add -A`. That `add -A` swept the audit file onto the PR branch:
			// 50+ commits titled `fix: auto-fix code quality [skip ci]` across
			// six PRs, each carrying a prompt file that has nothing to do with the
			// dependency bump it was fixing. The file also made `git status`
			// permanently dirty, so a later tick that legitimately found nothing
			// to change read as "the agent did nothing" and reported
			// `ran but no commit/push` forever.
			//
			// Writing beside the workdir instead keeps the audit trail without
			// putting it inside the tree the agent commits from.
			//
			// `node:path`'s `dirname`, not string surgery: `dirname("/tmp/wd/")`
			// is `/tmp`, where a trailing-slash strip followed by "remove the last
			// component" collapses the real parent one level too far. The worker
			// builds its paths by string concatenation, so a trailing separator is
			// a shape this can actually be handed.
			writeBestEffort(dirname(opts.workdir), `${opts.label}.prompt.txt`, prompt)
		}

		try {
			assertNotRoot(this.isRoot())
		} catch (e) {
			return { ok: false, snippet: `[INFRA] ${(e as Error).message}` }
		}

		const bin = this.bin ?? firstExistingClaude()
		if (!bin) {
			return {
				ok: false,
				snippet:
					`[INFRA] Claude Code binary not found (looked in ${CLAUDE_BIN_CANDIDATES.join(", ")}). ` +
					"The worker runs as a user that cannot read /home/code, so the binary must be installed root-owned.",
			}
		}

		// ORDER MATTERS: the prompt is LAST, after every flag. `-p` takes the next
		// argv entry as its value, so anything after the prompt would be parsed as
		// an option — and a prompt that happens to start with a flag-looking word
		// would break the whole invocation.
		const argv = [
			bin,
			"-p",
			// Bounds the agent's own tool loop, so a confused run cannot spend the
			// whole 1800s budget before the outer timeout has to kill it.
			"--max-turns",
			String(this.maxTurns),
			"--dangerously-skip-permissions",
			"--output-format",
			"text",
			"--model",
			this.model,
			prompt,
		]

		const env = buildEnv({ baseUrl: this.baseUrl, model: this.model, extra: {} })
		if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
			return {
				ok: false,
				snippet:
					"[INFRA] no Anthropic credential in the worker environment. " +
					"Expected ANTHROPIC_AUTH_TOKEN from Bitwarden (pr_agent_anthropic_auth_token).",
			}
		}

		let r: ProcResult
		try {
			r = this.spawn(argv, { cwd: workdir, timeoutMs: timeout * 1000, env })
		} catch (e) {
			return { ok: false, snippet: `[INFRA] failed to launch ${bin}: ${errorText(e)}` }
		}

		const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
		if (r.exitedDueToTimeout) {
			return { ok: false, snippet: `[INFRA] Claude Code timed out after ${timeout}s` }
		}
		if (r.code !== 0) {
			const detail = output.replace(/\n/g, " ").slice(0, DETAIL_HEAD)
			return { ok: false, snippet: `[INFRA] Claude Code exited ${r.code}: ${detail}` }
		}

		// A refused login or a missing credential is reported on stdout with a zero
		// exit, so the exit code alone does not prove the agent worked. "Not logged
		// in" is the exact text the CLI prints with no credential at all. Checked
		// BEFORE the pre-flight credential test below, because a stale-but-present
		// variable is the more misleading case: the CLI ran and told us it could
		// not authenticate.
		if (/Not logged in|Please run \/login/.test(output)) {
			return {
				ok: false,
				snippet:
					"[INFRA] Claude Code is not authenticated (no usable ANTHROPIC_AUTH_TOKEN). " +
					"Set pr_agent_anthropic_auth_token in Bitwarden.",
			}
		}

		return { ok: true, snippet: output.slice(-SNIPPET_TAIL).replace(/\s+/g, " ") }
	}
}

/** The first candidate binary that exists and is executable, or undefined. */
function firstExistingClaude(): string | undefined {
	for (const c of CLAUDE_BIN_CANDIDATES) {
		try {
			// `X_OK` is the real test: the file must be executable BY THIS USER,
			// which is the whole difficulty — the worker runs as `pr-agent` and
			// cannot read `/home/code`, so a developer-local install is invisible.
			accessSync(c, constants.X_OK)
			return c
		} catch {}
	}
	return undefined
}

/** Best-effort audit write; a failed audit must never fail the run. */
function writeBestEffort(dir: string, name: string, content: string): void {
	try {
		writeFileSync(`${dir}/${name}`, content)
	} catch {
		/* the prompt is a convenience, not a contract */
	}
}

/** `str(exc)` — an Error's own toString would add a redundant "Error:" prefix. */
function errorText(err: unknown): string {
	if (err instanceof Error) return err.message
	return String(err)
}

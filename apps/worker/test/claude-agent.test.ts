// Tests for the Claude Code CLI agent client.
//
// The gateway port this replaced had a large HTTP-contract suite. These tests
// cover what actually matters for the CLI: the argv it builds, the environment
// it hands over, and the refusals it has to recognise — all of which were silent
// failure modes when the agent ran through the Hermes gateway.

import { describe, expect, test } from "vitest"
import {
	AGENT_SYSTEM_PROMPT,
	AgentClient,
	AI_FIX_MAX_TURNS,
	CLAUDE_BIN_CANDIDATES,
	DEFAULT_ANTHROPIC_BASE_URL,
	DEFAULT_CLAUDE_MODEL,
	type PostResult,
	type Spawner,
} from "../src/claude-agent.ts"

const KEY = "sk-ant-test-key"

/** Records the argv/env/cwd it was called with and returns a canned result. */
function fakeSpawn(
	result: Partial<{
		code: number
		stdout: string
		stderr: string
		exitedDueToTimeout: boolean
	}> = {},
): Spawner & { seen: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv }[] } {
	const seen: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = []
	const spawn: Spawner = (argv, opts) => {
		seen.push({ argv, cwd: opts.cwd, env: opts.env })
		return {
			code: 0,
			stdout: "done",
			stderr: "",
			exitedDueToTimeout: false,
			...result,
		}
	}
	return Object.assign(spawn, { seen })
}

function client(spawn: Spawner, opts: Record<string, unknown> = {}) {
	process.env.ANTHROPIC_AUTH_TOKEN = KEY
	return new AgentClient({
		bin: "/usr/local/bin/claude",
		spawn,
		isRoot: () => false,
		...opts,
	})
}

describe("AgentClient — Claude Code CLI", () => {
	test("invokes the CLI non-interactively with skip-permissions in the worktree", async () => {
		const spawn = fakeSpawn()
		const r = await client(spawn).post("do the thing", { workdir: "/tmp/wd", timeoutSec: 60 })

		expect(r.ok).toBe(true)
		expect(spawn.seen).toHaveLength(1)
		const { argv, cwd, env } = spawn.seen[0]!

		// Non-interactive: -p reads the prompt from argv and exits. Without it the
		// CLI opens an interactive TUI and the tick hangs forever.
		expect(argv).toContain("-p")
		// The whole point of the migration: no permission prompts, unattended.
		expect(argv).toContain("--dangerously-skip-permissions")
		// Text output keeps stdout parseable; stream-json would not be.
		expect(argv[argv.indexOf("--output-format") + 1]).toBe("text")
		expect(argv[argv.indexOf("--model") + 1]).toBe(DEFAULT_CLAUDE_MODEL)
		expect(argv[argv.indexOf("--max-turns") + 1]).toBe(String(AI_FIX_MAX_TURNS))
		// The prompt is positional and LAST, so a prompt containing a flag-looking
		// word can never be parsed as an option.
		expect(argv[argv.length - 1]).toBe("do the thing")
		// The agent edits the worktree, so that is the cwd.
		expect(cwd).toBe("/tmp/wd")
		expect(env.ANTHROPIC_BASE_URL).toBe(DEFAULT_ANTHROPIC_BASE_URL)
	})

	// Ruling: the worker must never run this as root. Claude Code refuses
	// --dangerously-skip-permissions under root, and refusing is correct — the
	// flag means "act unattended with no prompts".
	test("refuses to run as root, and says why", async () => {
		const spawn = fakeSpawn()
		process.env.ANTHROPIC_AUTH_TOKEN = KEY
		const c = new AgentClient({ bin: "/usr/local/bin/claude", spawn, isRoot: () => true })
		const r = await c.post("x", { workdir: "/tmp/wd" })

		expect(r.ok).toBe(false)
		expect(r.snippet).toContain("[INFRA]")
		expect(r.snippet).toMatch(/root/i)
		// The message must not tell the operator to drop the flag.
		expect(r.snippet).not.toMatch(/drop the flag|remove the flag/i)
		// Nothing was launched at all.
		expect(spawn.seen).toHaveLength(0)
	})

	// Claude Code prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN when both
	// are set, so a stale key in the environment silently wins over the vault.
	test("blanks ANTHROPIC_API_KEY so the vault token is authoritative", async () => {
		process.env.ANTHROPIC_API_KEY = "stale-key-that-would-win"
		const spawn = fakeSpawn()
		await client(spawn).post("x", { workdir: "/tmp/wd" })

		expect(spawn.seen[0]!.env.ANTHROPIC_API_KEY).toBe("")
		expect(spawn.seen[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY)
		delete process.env.ANTHROPIC_API_KEY
	})

	// pr-agent's passwd shell is /usr/sbin/nologin, and the agent's Bash tool
	// spawns $SHELL — without this every command exits 1 with no output and the
	// agent reports it cannot do anything.
	test("forces a real SHELL and an explicit PATH", async () => {
		process.env.SHELL = "/usr/sbin/nologin"
		const spawn = fakeSpawn()
		await client(spawn).post("x", { workdir: "/tmp/wd" })

		const env = spawn.seen[0]!.env
		expect(env.SHELL).toBe("/bin/sh")
		expect(env.PATH).toContain("/usr/local/bin")
		expect(env.PATH).toContain("/usr/bin")
		delete process.env.SHELL
	})

	test("no credential at all is an INFRA failure, not a silent success", async () => {
		const spawn = fakeSpawn({ stdout: "Not logged in · Please run /login" })
		const prev = process.env.ANTHROPIC_AUTH_TOKEN
		const prevKey = process.env.ANTHROPIC_API_KEY
		delete process.env.ANTHROPIC_AUTH_TOKEN
		delete process.env.ANTHROPIC_API_KEY
		try {
			const c = new AgentClient({
				bin: "/usr/local/bin/claude",
				spawn,
				isRoot: () => false,
			})
			const r = await c.post("x", { workdir: "/tmp/wd" })
			expect(r.ok).toBe(false)
			expect(r.snippet).toContain("ANTHROPIC_AUTH_TOKEN")
		} finally {
			if (prev !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = prev
			if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey
		}
	})

	// The CLI reports a missing login on stdout with exit 0, so the exit code
	// alone does not prove the agent worked.
	test("treats 'Not logged in' on a zero exit as a failure", async () => {
		// A token is PRESENT but unusable (expired/wrong): the pre-flight check
		// passes, the CLI runs, and it reports the refusal with exit 0. Without
		// this check that reads as a successful run that changed nothing.
		const spawn = fakeSpawn({ code: 0, stdout: "Not logged in · Please run /login" })
		process.env.ANTHROPIC_AUTH_TOKEN = "stale-but-present"
		try {
			const c = new AgentClient({
				bin: "/usr/local/bin/claude",
				spawn,
				isRoot: () => false,
			})
			const r = await c.post("x", { workdir: "/tmp/wd" })
			expect(r.ok).toBe(false)
			expect(r.snippet).toMatch(/not authenticated/i)
		} finally {
			process.env.ANTHROPIC_AUTH_TOKEN = KEY
		}
	})

	test("a timeout is reported as a timeout, not a generic exit", async () => {
		const spawn = fakeSpawn({ code: 124, stdout: "", exitedDueToTimeout: true })
		const r = await client(spawn).post("x", { workdir: "/tmp/wd", timeoutSec: 1800 })
		expect(r.ok).toBe(false)
		expect(r.snippet).toContain("timed out after 1800s")
	})

	test("a non-zero exit is an INFRA failure carrying the CLI's own words", async () => {
		const spawn = fakeSpawn({ code: 2, stdout: "", stderr: "Invalid API key" })
		const r = await client(spawn).post("x", { workdir: "/tmp/wd" })
		expect(r.ok).toBe(false)
		expect(r.snippet).toContain("[INFRA]")
		expect(r.snippet).toContain("exited 2")
		expect(r.snippet).toContain("Invalid API key")
	})

	test("the candidate list puts the root-owned install first", () => {
		// The worker runs as `pr-agent`, which cannot read /home/code, so a
		// developer-local install is invisible to it. The root-owned path has to
		// be tried first or the fallback is dead code in production.
		expect(CLAUDE_BIN_CANDIDATES[0]).toBe("/usr/local/bin/claude")
		expect(CLAUDE_BIN_CANDIDATES).toContain("/usr/bin/claude")
	})

	test("a spawning throw (ENOENT) becomes an INFRA failure, not a crash", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = KEY
		const spawn: Spawner = () => {
			throw Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" })
		}
		const c = new AgentClient({ bin: "/usr/local/bin/claude", spawn, isRoot: () => false })
		const r = await c.post("x", { workdir: "/tmp/wd" })
		expect(r.ok).toBe(false)
		expect(r.snippet).toContain("failed to launch")
	})

	test("writes the prompt BESIDE the workdir, never inside it", async () => {
		const spawn = fakeSpawn()
		process.env.ANTHROPIC_AUTH_TOKEN = KEY
		// Drive the real write path against a temp dir.
		const { existsSync, mkdirSync, mkdtempSync, readFileSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const { join } = await import("node:path")
		// The workdir is a real subdirectory, mirroring the clone layout the
		// worker builds — the prompt must land in its PARENT.
		const parent = mkdtempSync(join(tmpdir(), "pr-agent-prompt-"))
		const dir = join(parent, "work")
		mkdirSync(dir)
		const c = new AgentClient({ bin: "/usr/local/bin/claude", spawn, isRoot: () => false })
		await c.post("the exact prompt", { workdir: dir, label: "claude_pr_7" })

		// Replayable from the parent…
		expect(readFileSync(join(parent, "claude_pr_7.prompt.txt"), "utf8")).toBe("the exact prompt")
		// …and NOT inside the tree the agent commits from. This is the assertion
		// that matters: the prompt is written BEFORE the agent runs, its own
		// instruction is `git add -A`, and an in-worktree audit file was swept
		// onto six PR branches as 50+ `fix: auto-fix code quality [skip ci]`
		// commits. It also left the tree permanently dirty, which made a later
		// tick's legitimate "nothing to change" read as "the agent did nothing".
		expect(existsSync(join(dir, "claude_pr_7.prompt.txt"))).toBe(false)
	})

	test("the prompt still lands beside a workdir given with a trailing slash", async () => {
		// `dirname("/x/wd/")` is `/x`, so a workdir written with a trailing
		// separator still puts the audit file in its real parent. The worker
		// builds workdir paths by string concatenation, so this shape is
		// reachable — and a string-surgery "strip the slash, drop the last
		// segment" implementation would instead write to the grandparent.
		const spawn = fakeSpawn()
		process.env.ANTHROPIC_AUTH_TOKEN = KEY
		const { existsSync, mkdirSync, mkdtempSync, readFileSync } = await import("node:fs")
		const { tmpdir } = await import("node:os")
		const { join } = await import("node:path")
		const parent = mkdtempSync(join(tmpdir(), "pr-agent-slash-"))
		const work = join(parent, "wd")
		mkdirSync(work)
		const c = new AgentClient({ bin: "/usr/local/bin/claude", spawn, isRoot: () => false })
		await c.post("p", { workdir: `${work}/`, label: "claude_pr_9" })

		// `dirname` of the trailing-slash path is the parent, which is where the
		// audit belongs.
		expect(readFileSync(join(parent, "claude_pr_9.prompt.txt"), "utf8")).toBe("p")
		// Not in the worktree itself.
		expect(existsSync(join(work, "claude_pr_9.prompt.txt"))).toBe(false)
	})

	test("never throws — every path returns a PostResult", async () => {
		process.env.ANTHROPIC_AUTH_TOKEN = KEY
		const hostile: Spawner = () => {
			throw new Error("boom")
		}
		const c = new AgentClient({ bin: "/usr/local/bin/claude", spawn: hostile, isRoot: () => false })
		const r: PostResult = await c.post("x", { workdir: "/tmp/wd" })
		expect(typeof r.ok).toBe("boolean")
		expect(typeof r.snippet).toBe("string")
	})

	test("runSync runs the same CLI with the sync timeout budget", async () => {
		const spawn = fakeSpawn()
		process.env.ANTHROPIC_AUTH_TOKEN = KEY
		const c = new AgentClient({ bin: "/usr/local/bin/claude", spawn, isRoot: () => false })
		const r = await c.runSync({
			workdir: "/tmp/sync",
			prompt: "reconcile",
			label: "sync_o_repo",
			fork: "o/repo",
		})
		expect(r.ok).toBe(true)
		expect(spawn.seen[0]!.cwd).toBe("/tmp/sync")
		expect(spawn.seen[0]!.argv[spawn.seen[0]!.argv.length - 1]).toBe("reconcile")
	})

	// Byte-exact: this string is what tells the agent not to push, so it is
	// asserted as a literal rather than against the exported constant (which
	// would be a tautology).
	test("the no-push system prompt is byte-exact", () => {
		expect(AGENT_SYSTEM_PROMPT).toBe(
			"You are an autonomous coding agent inside a git worktree. Use your terminal and file tools to complete the task. Work ONLY inside the current working directory. Do NOT push.",
		)
	})
})

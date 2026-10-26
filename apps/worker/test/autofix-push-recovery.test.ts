// REGRESSION: a non-fast-forward push must not destroy the agent's run.
//
// GMW#125 spent 335s in Claude Code, committed, and then lost everything:
//
//   ⏭️ AI fix skipped: AI committed but push failed: To https://github.com/...
//   ! [rejected] HEAD -> dependabot/npm_and_yarn/development-5a95efaeba (fetch first)
//
// Dependabot had re-run and moved the branch while the agent was thinking. The
// old code treated "the branch moved" as "give up", so the next tick re-cloned
// and re-prompted from scratch — paying the same expensive run to rediscover
// the same edits. A branch moving under a five-minute worker is the ORDINARY
// case, not an exotic one, so the retry has to live INSIDE the run.
//
// This drives `runAiFix` against a real bare remote and a real clone, so the
// rejection is git's own rather than a canned string. The agent is faked (no
// model is called) and the clone URL is redirected from github.com to a local
// bare repo; every git subcommand, every ref update, and the rejection itself
// are git's.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"

import type { GitResult, GitRunner } from "../src/git.ts"
import { runAiFix } from "../src/pr/autofix.ts"
import { TMP_BASE, type Workdirs } from "../src/pr/lockfix.ts"

const BRANCH = "dependabot/npm_and_yarn/development-5a95efaeba"
const BASE = "main"

/**
 * `runAiFix` derives every workdir from the hardcoded `TMP_BASE`, which is the
 * PRODUCTION worker's directory. One helper rewrites that prefix into the
 * test's own root so every fake (fs, git cwd, git args, agent) agrees on the
 * same path; nothing else about the path is changed.
 */
const localPath = (root: string, p: string) =>
	join(root, "wd", p.replace(TMP_BASE, "").replace(/^\/+/, ""))

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
}

/** A real repo, and the commands in it run for real. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...GIT_ENV },
	})
}

function commitFile(repo: string, file: string, body: string, msg: string): void {
	writeFileSync(join(repo, file), body)
	git(repo, "add", "-A")
	git(repo, "commit", "-q", "-m", msg)
}

/**
 * Bare remote + a developer checkout that seeds it, shaped like a Dependabot
 * PR: `main` exists and the PR branch is one commit ahead of it changing
 * `package.json` — the file the fake agent rewrites.
 */
function seedRemote(): { remote: string; work: string; root: string } {
	const root = mkdtempSync(join(tmpdir(), "autofix-ff-"))
	const remote = join(root, "origin.git")
	const work = join(root, "dev")

	git(root, "init", "-q", "--bare", remote)
	git(remote, "symbolic-ref", "HEAD", `refs/heads/${BASE}`)

	mkdirSync(work)
	git(work, "init", "-q", "-b", BASE)
	commitFile(work, "package.json", '{"name":"x","version":"1.0.0"}\n', "chore: init")
	git(work, "remote", "add", "origin", remote)
	git(work, "push", "-q", "origin", BASE)

	git(work, "checkout", "-q", "-b", BRANCH)
	commitFile(
		work,
		"package.json",
		'{"name":"x","version":"1.0.0","devDependencies":{"vitest":"^1.0.0"}}\n',
		"build(deps-dev): bump the development group",
	)
	git(work, "push", "-q", "origin", BRANCH)

	return { remote, work, root }
}

/**
 * The real runner. The ONLY rewrite is the transport: `clonePr` builds a
 * `https://…github.com/<repo>.git` URL, which is pointed at the local bare
 * repo so no network and no token are involved. Every argument is recorded so
 * the retry (and the absence of a force-push) is visible.
 */
function realRunner(remote: string, root: string): { run: GitRunner; calls: string[][] } {
	const calls: string[][] = []
	// `runAiFix` derives its workdir from the hardcoded TMP_BASE; rewrite it into
	// the test's root so git never touches the production clone directory.
	const redirect = (p: string | undefined) =>
		p === undefined ? undefined : p.startsWith(TMP_BASE) ? localPath(root, p) : p
	const run: GitRunner = (args, cwd, timeoutSec): GitResult => {
		calls.push([...args])
		// `<url> <target> --branch <ref> --depth N` → swap in the local remote and
		// move the clone target into the test root.
		const rewritten = args.map((a) =>
			a.includes("github.com/") ? remote : redirect(a),
		) as string[]

		try {
			const stdout = execFileSync("git", rewritten, {
				cwd: redirect(cwd),
				encoding: "utf8",
				timeout: timeoutSec ? timeoutSec * 1000 : undefined,
				env: { ...process.env, ...GIT_ENV },
				stdio: ["ignore", "pipe", "pipe"],
			})

			// A real `git clone --branch X --depth N` from GitHub leaves the other
			// branches fetchable by name (the remote has a `+refs/heads/*` refspec).
			// Cloning a LOCAL path applies `--single-branch`, so `fetch origin main`
			// would create no `origin/main` and the diff would come back empty.
			// Re-open the wildcard refspec AFTER the clone so the fixture's remote
			// behaves like github.com's.
			if (rewritten[0] === "clone") {
				const target = rewritten.find((a) => a.startsWith(join(root, "wd")))
				if (target && existsSync(target)) {
					try {
						execFileSync(
							"git",
							["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
							{
								cwd: target,
								env: { ...process.env, ...GIT_ENV },
							},
						)
					} catch {
						/* cosmetic: the caller reports any real git failure */
					}
				}
			}

			return { code: 0, stdout, stderr: "" }
		} catch (err) {
			const e = err as { status?: number; stdout?: string; stderr?: string }
			return {
				code: typeof e.status === "number" ? e.status : 1,
				stdout: e.stdout ? String(e.stdout) : "",
				stderr: e.stderr ? String(e.stderr) : "",
			}
		}
	}
	return { run, calls }
}

/**
 * The agent commits a fix, exactly as the CLI does on success: the WORKER then
 * pushes (prompt rule 4 forbids the agent from pushing), which is the step
 * under test.
 */
function committingAgent(root: string, file: string, body: string, duringRun?: () => void) {
	const local = (p: string) => localPath(root, p)
	return {
		async post(_prompt: string, opts: { workdir?: string }) {
			if (!opts.workdir) throw new Error("no workdir")
			// The race has to land INSIDE the run: `duringRun` is where another
			// actor (Dependabot re-running, a maintainer) moves the branch while
			// the agent is still thinking. Doing it before `runAiFix` would let
			// the clone pick it up and prove nothing.
			duringRun?.()
			commitFile(local(opts.workdir), file, body, "fix: relax the floating dev dependency")
			return { ok: true, snippet: "" }
		},
	}
}

/**
 * The real on-disk workdirs, with paths REDIRECTED into the test's tmp root.
 *
 * `runAiFix` hardcodes `TMP_BASE` = /tmp/pr-queue-work, which belongs to the
 * production worker user — a test must never write there, and must never reuse
 * a live clone either. The redirect is a prefix rewrite only; every fs call
 * still goes to the real filesystem.
 */
function scopedWorkdirs(root: string): Workdirs {
	const local = (p: string) => localPath(root, p)
	return {
		exists: (p) => existsSync(local(p)),
		mkdir: (p) => mkdirSync(local(p), { recursive: true }),
		remove: (p) => rmSync(local(p), { recursive: true, force: true }),
		writeFile: (p, c) => writeFileSync(local(p), c),
		readFile: (p) => readFileSync(local(p), "utf8"),
	}
}

describe("runAiFix push recovery", () => {
	let roots: string[] = []
	afterEach(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true })
		roots = []
	})

	test("rebases onto a branch that moved mid-run and still lands the fix", async () => {
		const { remote, work, root } = seedRemote()
		roots.push(root)

		// THE RACE: someone else pushes to the branch while the agent works. A
		// bare `push` is then rejected non-fast-forward — the GMW#125 failure.
		let movedTo = ""
		const race = () => {
			commitFile(work, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n", "chore: refresh lockfile")
			git(work, "push", "-q", "origin", BRANCH)
			movedTo = git(work, "rev-parse", "HEAD").trim()
		}

		const { run, calls } = realRunner(remote, root)
		const result = await runAiFix(
			{
				run,
				workdirs: scopedWorkdirs(root),
				agent: committingAgent(
					root,
					"package.json",
					'{"name":"x","version":"1.1.0"}\n',
					race,
				) as never,
				api: { request: async () => ({ status: 200, data: [] }) } as never,
			},
			// The repo key only names the workdir; the transport is redirected above.
			"local/tmp",
			1,
			"bump",
			git(work, "rev-parse", `origin/${BRANCH}`).trim(),
			BRANCH,
			BASE,
			"token",
		)

		expect(movedTo).not.toBe("")
		expect(result.ok).toBe(true)
		// The agent's fix reached the remote...
		expect(git(remote, "log", "-1", "--format=%s", BRANCH)).toContain(
			"relax the floating dev dependency",
		)
		// ...on TOP of the commit that arrived during the run, not replacing it.
		git(remote, "merge-base", "--is-ancestor", movedTo, BRANCH)
		// The recovery was a rebase, not a force-push.
		expect(calls.filter((c) => c[0] === "rebase" && c[1] !== "--abort").length).toBe(1)
		expect(calls.some((c) => c.includes("--force"))).toBe(false)
		// The lockfile change that raced us in is still on the branch.
		expect(git(remote, "show", `${BRANCH}:pnpm-lock.yaml`)).toContain("lockfileVersion")
	})

	test("a rebase that conflicts is aborted and reported, never force-pushed", async () => {
		const { remote, work, root } = seedRemote()
		roots.push(root)

		// A conflicting change to the SAME line the agent rewrites, landing DURING
		// the run. Both sides rewrite package.json wholesale, so the rebase cannot
		// mechanically merge them — exactly the case that must be refused.
		const race = () => {
			commitFile(work, "package.json", '{"name":"x","version":"9.9.9"}\n', "chore: unrelated bump")
			git(work, "push", "-q", "origin", BRANCH)
		}

		const { run, calls } = realRunner(remote, root)
		const result = await runAiFix(
			{
				run,
				workdirs: scopedWorkdirs(root),
				agent: committingAgent(
					root,
					"package.json",
					'{"name":"x","version":"1.1.0"}\n',
					race,
				) as never,
				api: { request: async () => ({ status: 200, data: [] }) } as never,
			},
			"local/tmp",
			2,
			"bump",
			git(work, "rev-parse", `origin/${BRANCH}`).trim(),
			BRANCH,
			BASE,
			"token",
		)

		// A commit that cannot replay is a genuine refusal — reported, not papered over.
		expect(result.ok).toBe(false)
		expect(result.summary).toContain("push failed")
		// The rebase was started, then aborted: the workdir is not left mid-rebase.
		expect(calls.some((c) => c[0] === "rebase" && c[1] === "--abort")).toBe(true)
		// And the remote is untouched — no forced overwrite of the other commit.
		expect(git(remote, "log", "-1", "--format=%s", BRANCH)).toContain("unrelated bump")
		expect(calls.some((c) => c.includes("--force"))).toBe(false)
	})
})

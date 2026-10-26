/**
 * The package-manager table and the dispatch that replaced the bun-or-uv branch.
 *
 * WHAT THESE TESTS EXIST FOR. Before this, a Dependabot lockfile bump was
 * repaired only for bun and uv, chosen by a `bun.lock` substring probe — so an
 * npm, pnpm or yarn repo fell through to the AI agent, which edits source files
 * and cannot regenerate a lockfile. The tests below pin the two halves of the
 * fix: the table recognises every toolchain, and the flow drives the right argv
 * for each one without touching the bun/uv contracts that already shipped.
 */

import { describe, expect, test } from "vitest"
import type { GitResult, GitRunner } from "../src/git.ts"
import { type LockfixDeps, type ProcRunner, TMP_BASE, type Workdirs } from "../src/pr/lockfix.ts"
import {
	detectPackageManagers,
	PACKAGE_MANAGERS,
	type PackageManager,
	packageManagerById,
	pathIsLockfile,
} from "../src/pr/managers.ts"
import { fixLockfile } from "../src/pr/relock.ts"
import type { GhClient } from "../src/pr/scan.ts"

const REPO = "owner/repo"
const PR = 7
const HEAD_REF = "dependabot/npm/left-pad"
const BASE_REF = "main"

/** A successful no-op result, so a fake only names the calls it cares about. */
const OK: GitResult = { code: 0, stdout: "", stderr: "" }

/** A non-zero result, for the arms a test wants to fail. */
const FAILED = (stderr = ""): GitResult => ({ code: 1, stdout: "", stderr })

/** The frozen probe's failure — the diagnosis that the lockfile is stale. */
const frozenFails =
	(stderr = "") =>
	(args: string[]) =>
		args.includes("--frozen-lockfile") || args.join(" ") === "npm ci" ? FAILED(stderr) : undefined

/**
 * A registered row, asserted present.
 *
 * `packageManagerById` is deliberately `| undefined` for callers that name a
 * toolchain dynamically; these tests name one they KNOW the table has, so a
 * missing row is a broken table and should fail loudly rather than skip.
 */
function manager(id: string): PackageManager {
	const pm = packageManagerById(id)
	if (!pm) throw new Error(`no ${id} row in PACKAGE_MANAGERS`)
	return pm
}

// ── A repo tree served by a fake GitHub client ──────────────────────────────

/** A `GhClient` whose tree endpoint answers with `paths`, and nothing else. */
function treeApi(paths: string[], opts: { status?: number; throw?: boolean } = {}): GhClient {
	const status = opts.status ?? 200
	return {
		async request() {
			if (opts.throw) throw new Error("boom")
			return { status, data: { tree: paths.map((path) => ({ path })) } }
		},
	} as unknown as GhClient
}

describe("detectPackageManagers", () => {
	test("recognises every row's lockfile at the repo root", async () => {
		for (const pm of PACKAGE_MANAGERS) {
			const found = await detectPackageManagers(treeApi([pm.lockfiles[0]]), "t", REPO, "sha")
			expect(found.map((f) => f.id)).toEqual([pm.id])
		}
	})

	test("finds a lockfile in a workspace, not only at the root", async () => {
		const api = treeApi(["package.json", "apps/web/pnpm-lock.yaml"])
		expect((await detectPackageManagers(api, "t", REPO, "sha")).map((p) => p.id)).toEqual(["pnpm"])
	})

	test("returns EVERY toolchain present, in table order", async () => {
		// A monorepo can genuinely hold a pnpm workspace and a uv sub-project. The
		// old binary probe could only answer one question, so the other toolchain
		// was never repaired — this is the reason detection returns a list.
		const api = treeApi(["uv.lock", "pnpm-lock.yaml", "src/index.ts"])
		expect((await detectPackageManagers(api, "t", REPO, "sha")).map((p) => p.id)).toEqual([
			"pnpm",
			"uv",
		])
	})

	test("a repo with no recognised lockfile yields none", async () => {
		const api = treeApi(["package.json", "README.md"])
		expect(await detectPackageManagers(api, "t", REPO, "sha")).toEqual([])
	})

	test("a non-200, a bad body and a throw all mean 'no toolchain'", async () => {
		// Detection only chooses a repair, so it must never be able to fail a tick.
		for (const api of [
			treeApi(["pnpm-lock.yaml"], { status: 500 }),
			treeApi([], { throw: true }),
		]) {
			expect(await detectPackageManagers(api, "t", REPO, "sha")).toEqual([])
		}
	})
})

describe("pathIsLockfile", () => {
	test("matches on the whole last segment", () => {
		expect(pathIsLockfile("apps/web/pnpm-lock.yaml", ["pnpm-lock.yaml"])).toBe(true)
		// The substring probe this replaced matched all three of these.
		expect(pathIsLockfile("docs/bun.lock.md", ["bun.lock"])).toBe(false)
		expect(pathIsLockfile("bun.lock.bak", ["bun.lock"])).toBe(false)
		expect(pathIsLockfile("bun.lock", ["bun.lock", "bun.lockb"])).toBe(true)
	})
})

describe("the table itself", () => {
	test("ids are unique, because the id is the workdir namespace", () => {
		const ids = PACKAGE_MANAGERS.map((pm) => pm.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	test("every row manages at least one lockfile and can be looked up", () => {
		for (const pm of PACKAGE_MANAGERS) {
			expect(pm.lockfiles.length).toBeGreaterThan(0)
			expect(packageManagerById(pm.id)).toBe(pm)
		}
	})

	test("npm, pnpm, yarn, bun and the rest of the fleet are all present", () => {
		// The user's requirement in one assertion: "semua" — not just the one
		// package manager that happened to break CI this time.
		for (const id of ["npm", "pnpm", "yarn", "bun", "uv", "go", "composer", "bundler"]) {
			expect(packageManagerById(id), `missing row: ${id}`).toBeDefined()
		}
	})
})

// ── The flow, driven for one row at a time ──────────────────────────────────

type Proc = { args: string[]; cwd?: string; timeoutSec?: number }

/** What a `deps()` fake answers with; anything unmentioned is a success. */
type Replies = {
	/** Answer for a git argv, or `undefined` for the default success. */
	git?: (args: string[]) => GitResult | undefined
	/** Answer for a non-git argv, or `undefined` for the default success. */
	exec?: (args: string[]) => GitResult | undefined
	/** The PAT `fetchGhToken` hands back; `""` models "no token". */
	token?: string
}

type Harness = {
	/** The injected deps. */
	d: LockfixDeps
	/** Git argv, in call order. */
	git: Proc[]
	/** Non-git argv (`npm ci`, `uv lock`, …), in call order. */
	proc: Proc[]
	/** Every workdir path `remove` was called with, in order. */
	removed: string[]
}

/** Everything `fixLockfile` touches, recorded. */
function deps(replies: Replies): Harness {
	const git: Proc[] = []
	const proc: Proc[] = []
	const removed: string[] = []
	const run: GitRunner = (args, cwd, timeoutSec) => {
		git.push({ args, cwd, timeoutSec })
		return replies.git?.(args) ?? OK
	}
	const exec: ProcRunner = (args, cwd, timeoutSec) => {
		proc.push({ args, cwd, timeoutSec })
		return replies.exec?.(args) ?? OK
	}
	const workdirs: Workdirs = {
		exists: () => false,
		mkdir: () => {},
		remove: (p) => void removed.push(p),
		writeFile: () => {},
		readFile: () => "",
	}
	const d: LockfixDeps = {
		run,
		exec,
		workdirs,
		fetchGhToken: () => replies.token ?? "gh-pat",
	}
	return { d, git, proc, removed }
}

/** The argv of every call, joined, for exact-order assertions. */
const joined = (procs: Proc[]): string[] => procs.map((p) => p.args.join(" "))

describe("fixLockfile drives each toolchain's own commands", () => {
	/** `git diff` reports exactly `lockfile`, so the flow reaches the commit. */
	const diffTouches =
		(lockfile: string) =>
		(args: string[]): GitResult | undefined =>
			args[0] === "diff" ? { code: 0, stdout: `${lockfile}\n`, stderr: "" } : undefined

	test("pnpm: frozen probe, then a non-frozen re-resolve, then commit only the lockfile", async () => {
		const pm = manager("pnpm")
		// The frozen probe FAILS — that is the diagnosis that the lockfile is stale.
		const h = deps({ git: diffTouches("pnpm-lock.yaml"), exec: frozenFails("ERR_PNPM") })

		const r = await fixLockfile(h.d, pm, REPO, PR, HEAD_REF, BASE_REF)

		expect(r).toEqual({ ok: true, summary: "pnpm-lock.yaml regenerated and pushed" })
		expect(joined(h.proc)).toEqual([
			"pnpm install --frozen-lockfile",
			"pnpm install --no-frozen-lockfile",
		])
		expect(joined(h.git)).toContain("add pnpm-lock.yaml")
		expect(joined(h.git)).toContain("commit -m chore: sync pnpm-lock.yaml after dependabot bump")
		expect(joined(h.git)).toContain(`push origin HEAD:${HEAD_REF}`)
	})

	test("npm: `npm ci` is the probe and `npm install` the re-resolve", async () => {
		const pm = manager("npm")
		const h = deps({ git: diffTouches("package-lock.json"), exec: frozenFails() })

		expect((await fixLockfile(h.d, pm, REPO, PR, HEAD_REF, BASE_REF)).ok).toBe(true)
		expect(joined(h.proc)).toEqual(["npm ci", "npm install"])
		expect(joined(h.git)).toContain("add package-lock.json")
	})

	test("yarn: v1's frozen flag, and the re-resolve is plain `yarn install`", async () => {
		const pm = manager("yarn")
		const h = deps({ git: diffTouches("yarn.lock"), exec: frozenFails() })

		expect((await fixLockfile(h.d, pm, REPO, PR, HEAD_REF, BASE_REF)).ok).toBe(true)
		expect(joined(h.proc)).toEqual(["yarn install --frozen-lockfile", "yarn install"])
	})

	test("a lockfile that is ALREADY consistent is reported, not re-resolved", async () => {
		// The probe passing means CI is red for another reason; pushing a
		// regenerated lockfile would be noise on a PR that was never broken there.
		const pm = manager("npm")
		// The probe PASSES, so the re-resolve must never be reached.
		const h = deps({ exec: () => OK })

		const r = await fixLockfile(h.d, pm, REPO, PR, HEAD_REF, BASE_REF)

		expect(r.ok).toBe(false)
		expect(r.summary).toContain("already consistent")
		expect(joined(h.proc)).toEqual(["npm ci"])
		expect(joined(h.git)).not.toContain("push")
	})

	test("a re-resolve that leaves the lockfile untouched does not push", async () => {
		const pm = manager("pnpm")
		const h = deps({
			// The installer touched a source file, not the lockfile.
			git: diffTouches("src/app.ts"),
			exec: frozenFails(),
		})

		const r = await fixLockfile(h.d, pm, REPO, PR, HEAD_REF, BASE_REF)

		expect(r.ok).toBe(false)
		expect(r.summary).toContain("unexpected files changed")
		expect(joined(h.git)).not.toContain("push")
	})

	test("each row clones into its own workdir, so two repairs cannot collide", async () => {
		const h = deps({ git: diffTouches("pnpm-lock.yaml") })
		const pnpm = manager("pnpm")
		const npm = manager("npm")

		await fixLockfile(h.d, pnpm, REPO, PR, HEAD_REF, BASE_REF)
		await fixLockfile(h.d, npm, REPO, PR, HEAD_REF, BASE_REF)

		const dirs = h.git.filter((c) => c.args[0] === "clone").map((c) => c.args[2])
		expect(dirs).toEqual([
			`${TMP_BASE}/owner_repo_pnpmfix_${PR}`,
			`${TMP_BASE}/owner_repo_npmfix_${PR}`,
		])
	})

	test("no token aborts before any command and still cleans the workdir", async () => {
		const pm = manager("pnpm")
		const h = deps({ token: "" })

		const r = await fixLockfile(h.d, pm, REPO, PR, HEAD_REF, BASE_REF)

		expect(r).toEqual({ ok: false, summary: "no gh token" })
		expect(h.git).toEqual([])
		expect(h.proc).toEqual([])
		expect(h.removed).toEqual([`${TMP_BASE}/owner_repo_pnpmfix_${PR}`])
	})
})

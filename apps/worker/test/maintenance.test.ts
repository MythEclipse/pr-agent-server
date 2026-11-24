import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { looksFlaky, runIdFromDetailsUrl, runTriage } from "../src/ops/ciTriage.ts"
import { formatBytes, guardDisk, parseDuOutput, reapWorkdirs } from "../src/ops/diskGuard.ts"
import { packageFromTitle, runHygiene, supersededPrs } from "../src/ops/hygiene.ts"
import { enforceRepoSettings, readSettings } from "../src/ops/repoSettings.ts"
import {
	codeqlLanguagesFor,
	codeqlWorkflowBody,
	codeScanningVerdict,
} from "../src/ops/syncHooks.ts"

/** A GitHub client that answers from a script and records every call. */
function fakeApi(routes: Record<string, { status: number; data?: any }>) {
	const calls: { method: string; path: string; json?: unknown }[] = []
	const api = {
		calls,
		request: async (method: string, path: string, opts?: { json?: unknown }) => {
			calls.push({ method, path, json: opts?.json })
			const key = `${method} ${path}`
			const hit = routes[key]
			if (hit) return { status: hit.status, data: hit.data }
			// Anything unrouted is a 404 with no body, which is what the callers
			// treat as "not there" rather than as a transport failure.
			return { status: 404, data: undefined }
		},
	}
	return api
}

describe("diskGuard", () => {
	const GB = 1024 * 1024 * 1024
	// Shared by the log assertions below.
	const lines: string[] = []
	const deps = (
		usedPct: number,
		afterCleanupPct: number,
		entries: { name: string; mtimeMs: number }[],
	) => {
		let reads = 0
		const removed: string[] = []
		const pruned: string[][] = []
		return {
			removed,
			pruned,
			deps: {
				usage: () => {
					// First two reads are "before", everything after is "after".
					reads += 1
					const pct = reads <= 2 ? usedPct : afterCleanupPct
					return { freeBytes: (100 - pct) * GB, totalBytes: 100 * GB }
				},
				list: () => entries.map((e) => ({ ...e, isDirectory: true })),
				remove: (p: string) => removed.push(p),
				prune: (argv: string[]) => {
					pruned.push(argv)
					return { code: 0 }
				},
				now: () => 1_000_000_000_000,
				log: () => {},
			},
		}
	}
	beforeEach(() => {
		lines.length = 0
	})

	it("reaps only directories this worker owns, and only stale ones", () => {
		const h = deps(90, 90, [
			{ name: "_vuln_o_r_pkg-1.0.0", mtimeMs: 0 },
			{ name: "pr-queue-old", mtimeMs: 0 },
			// Someone else's directory: never touched, however old.
			{ name: "someones-checkout", mtimeMs: 0 },
			// Young enough that a run could still be using it.
			{ name: "_vuln_in-flight", mtimeMs: 1_000_000_000_000 - 60_000 },
		])
		const res = reapWorkdirs(h.deps, {
			base: "/tmp/pr-queue-work",
			maxAgeMs: 6 * 60 * 60 * 1000,
			ownedPrefixes: ["_vuln_", "pr-queue-"],
		})
		expect(res.removed).toBe(2)
		expect(h.removed).toEqual([
			"/tmp/pr-queue-work/_vuln_o_r_pkg-1.0.0",
			"/tmp/pr-queue-work/pr-queue-old",
		])
	})

	it("does nothing at all below the reap threshold", () => {
		const h = deps(40, 40, [{ name: "_vuln_x", mtimeMs: 0 }])
		const res = guardDisk(h.deps, { base: "/tmp/pr-queue-work" })
		expect(res.removed).toBe(0)
		expect(h.removed).toEqual([])
		// No cache prune either: the cheap step was not even needed.
		expect(h.pruned).toEqual([])
		expect(res.refuse).toBe(false)
	})

	it("prunes the cache only when reaping was not enough, and reports a failure", () => {
		const h = deps(90, 96, [{ name: "_vuln_x", mtimeMs: 0 }])
		const res = guardDisk(h.deps, { base: "/tmp/pr-queue-work", refuseAtPct: 95 })
		expect(h.pruned).toEqual([["pnpm", "store", "prune"]])
		// A prune that exits non-zero is still REPORTED. The first version dropped
		// it into an `if (code === 0)` and claimed a cleanup that never happened —
		// `cargo cache clean` was not even installed.
		expect(res.pruned).toEqual(["pnpm store prune"])
		// 96% is above the hard limit, so the caller is told to stop.
		expect(res.refuse).toBe(true)
	})

	it("names the biggest directories instead of guessing at caches", () => {
		const h = deps(90, 90, [])
		const res = guardDisk(
			{
				...h.deps,
				// Measured shape on this box: /home 58G, /usr 13G, /var 8.5G — none of
				// it the worker's, which is why reporting beats guessing.
				scan: () => [
					{ path: "/var", bytes: 8.5 * GB },
					{ path: "/home", bytes: 58 * GB },
					{ path: "/usr", bytes: 13 * GB },
				],
				log: (line) => lines.push(line),
			},
			{ base: "/tmp/pr-queue-work", pruneCaches: false },
		)
		expect(res.usedPctBefore).toBe(90)
		expect(lines.filter((l) => l.includes(" is "))).toEqual([
			"disk: /home is 58.0G",
			"disk: /usr is 13.0G",
			"disk: /var is 8.5G",
		])
	})

	it("judges the threshold by the WORST filesystem, not just the clone directory", () => {
		// MEASURED on the box: `/tmp` is a 7.9G tmpfs at 15% while `/` is a 116G
		// disk at 90%. A guard that only measured the clone directory reported
		// "14%, nothing to do" while the disk the deploy unpacks into was nearly
		// full — the guard has to look at both.
		const res = guardDisk(
			{
				usage: (path) =>
					path === "/tmp/pr-queue-work"
						? { freeBytes: 85 * GB, totalBytes: 100 * GB } // 15% used
						: { freeBytes: 10 * GB, totalBytes: 100 * GB }, // 90% used
				list: () => [],
				remove: () => {},
				prune: () => ({ code: 0 }),
				now: () => 0,
				log: () => {},
			},
			{ base: "/tmp/pr-queue-work", pruneCaches: false, refuseAtPct: 95 },
		)
		expect(res.usedPctBefore).toBe(90)
		expect(res.usedPctAfter).toBe(90)
		expect(res.refuse).toBe(false)
	})

	it("parses du's human sizes, including a bare byte count and a decimal", () => {
		const parsed = parseDuOutput("58G	/home\n8.5G	/var\n0	/data\nnot-a-size	/x\n")
		expect(parsed).toEqual([
			{ path: "/home", bytes: 58 * GB },
			{ path: "/var", bytes: 8.5 * GB },
			{ path: "/data", bytes: 0 },
		])
	})

	it("reports bytes in the unit an operator reads", () => {
		expect(formatBytes(0)).toBe("0B")
		expect(formatBytes(1536)).toBe("1.5K")
		expect(formatBytes(14 * 1024 * 1024 * 1024)).toBe("14.0G")
	})
})

describe("repoSettings", () => {
	const repoBody = (scan: boolean, push: boolean) => ({
		status: 200,
		data: {
			security_and_analysis: {
				secret_scanning: { status: scan ? "enabled" : "disabled" },
				secret_scanning_push_protection: { status: push ? "enabled" : "disabled" },
			},
		},
	})

	it("reads the three endpoints into one posture", async () => {
		const api = fakeApi({
			"GET /repos/o/r": repoBody(true, false),
			"GET /repos/o/r/vulnerability-alerts": { status: 204 },
			"GET /repos/o/r/automated-security-fixes": {
				status: 200,
				data: { enabled: true, paused: false },
			},
		})
		const state = await readSettings(api as never, "o/r", "tok")
		expect(state).toMatchObject({
			vulnerabilityAlerts: true,
			automatedSecurityFixes: true,
			secretScanning: true,
			secretScanningPushProtection: false,
		})
	})

	it("turns push protection on and reports a converged repo", async () => {
		let patched = false
		const api = fakeApi({
			"GET /repos/o/r": repoBody(true, false),
			"GET /repos/o/r/vulnerability-alerts": { status: 204 },
			"GET /repos/o/r/automated-security-fixes": { status: 200, data: { enabled: true } },
			"PATCH /repos/o/r": { status: 200, data: {} },
		})
		// After the PATCH the re-read must show the setting on, or the run reports
		// the repo as blocked — which is the whole point of re-reading.
		const original = api.request
		api.request = async (method: string, path: string, opts?: { json?: unknown }) => {
			if (method === "PATCH") patched = true
			if (method === "GET" && path === "/repos/o/r" && patched) {
				api.calls.push({ method, path, json: opts?.json })
				return { status: 200, data: repoBody(true, true).data }
			}
			return original(method, path, opts)
		}

		const res = await enforceRepoSettings(api as never, {
			repos: ["o/r"],
			token: "tok",
			dry: false,
			log: () => {},
		})
		expect(res.converged).toBe(true)
		const patch = api.calls.find((c) => c.method === "PATCH")
		expect(patch?.json).toEqual({
			security_and_analysis: { secret_scanning_push_protection: { status: "enabled" } },
		})
	})

	it("reports a repo as blocked when the setting is still off afterwards", async () => {
		// The PATCH answers 200 and changes nothing: an App whose permission was
		// downgraded. Trusting the status code would report this as converged.
		const api = fakeApi({
			"GET /repos/o/r": repoBody(false, false),
			"GET /repos/o/r/vulnerability-alerts": { status: 204 },
			"GET /repos/o/r/automated-security-fixes": { status: 200, data: { enabled: true } },
			"PATCH /repos/o/r": { status: 200, data: {} },
		})
		const res = await enforceRepoSettings(api as never, {
			repos: ["o/r"],
			token: "tok",
			dry: false,
			log: () => {},
		})
		expect(res.converged).toBe(false)
		expect(res.blocked[0]).toContain("secret scanning")
	})

	it("writes nothing in a dry run", async () => {
		const api = fakeApi({
			"GET /repos/o/r": repoBody(false, false),
			"GET /repos/o/r/vulnerability-alerts": { status: 404 },
			"GET /repos/o/r/automated-security-fixes": { status: 404 },
		})
		await enforceRepoSettings(api as never, {
			repos: ["o/r"],
			token: "tok",
			dry: true,
			log: () => {},
		})
		expect(api.calls.some((c) => c.method === "PUT" || c.method === "PATCH")).toBe(false)
	})
})

describe("hygiene", () => {
	it("reads the package out of the title this worker writes", () => {
		expect(packageFromTitle("fix(deps): bump undici to 7.30.1 for GHSA-x")).toBe("undici")
		expect(packageFromTitle("something else")).toBeNull()
	})

	it("keeps the newest PR per package and returns the rest", () => {
		const prs = [
			{
				number: 1,
				ref: "fix/vuln-minimatch-10.0.0-a",
				sha: "a",
				title: "fix(deps): bump minimatch to 10.0.0",
				createdAt: "2026-11-15T00:00:00Z",
			},
			{
				number: 2,
				ref: "fix/vuln-minimatch-11.0.1-b",
				sha: "b",
				title: "fix(deps): bump minimatch to 11.0.1",
				createdAt: "2026-11-17T00:00:00Z",
			},
			{
				number: 3,
				ref: "fix/vuln-esbuild-0.25.0-c",
				sha: "c",
				title: "fix(deps): bump esbuild to 0.25.0",
				createdAt: "2026-11-16T00:00:00Z",
			},
		]
		expect(supersededPrs(prs).map((p) => p.number)).toEqual([1])
	})

	it("closes the superseded PR, then deletes the branch it left behind", async () => {
		const api = fakeApi({
			"GET /repos/o/r/pulls?state=open&per_page=100": {
				status: 200,
				data: [
					{
						number: 1,
						title: "fix(deps): bump minimatch to 10.0.0",
						created_at: "2026-11-15T00:00:00Z",
						head: { ref: "fix/vuln-minimatch-10.0.0-a", sha: "a" },
					},
					{
						number: 2,
						title: "fix(deps): bump minimatch to 11.0.1",
						created_at: "2026-11-17T00:00:00Z",
						head: { ref: "fix/vuln-minimatch-11.0.1-b", sha: "b" },
					},
				],
			},
			"GET /repos/o/r/branches?per_page=100": {
				status: 200,
				data: [
					{ name: "fix/vuln-minimatch-10.0.0-a" },
					{ name: "fix/vuln-minimatch-11.0.1-b" },
					{ name: "main" },
				],
			},
			"POST /repos/o/r/issues/1/comments": { status: 201, data: {} },
			"PATCH /repos/o/r/pulls/1": { status: 200, data: {} },
			"DELETE /repos/o/r/git/refs/heads/fix/vuln-minimatch-10.0.0-a": { status: 204 },
		})
		// The second listing is the post-close re-read: PR 1 is gone.
		const original = api.request
		let pullReads = 0
		api.request = async (method: string, path: string, opts?: { json?: unknown }) => {
			if (method === "GET" && path === "/repos/o/r/pulls?state=open&per_page=100") {
				pullReads += 1
				if (pullReads > 1) {
					api.calls.push({ method, path, json: opts?.json })
					return {
						status: 200,
						data: [
							{
								number: 2,
								title: "fix(deps): bump minimatch to 11.0.1",
								created_at: "2026-11-17T00:00:00Z",
								head: { ref: "fix/vuln-minimatch-11.0.1-b", sha: "b" },
							},
						],
					}
				}
			}
			return original(method, path, opts)
		}

		const res = await runHygiene({
			api: api as never,
			token: "tok",
			repos: ["o/r"],
			dry: false,
			log: () => {},
		})
		expect(res.closed).toBe(1)
		expect(res.deleted).toBe(1)
		// `main` is never a candidate: the prefix is the permission model.
		expect(api.calls.some((c) => c.path.includes("/git/refs/heads/main"))).toBe(false)
		expect(
			api.calls.some((c) => c.path.includes("/git/refs/heads/fix/vuln-minimatch-11.0.1-b")),
		).toBe(false)
	})
})

describe("ciTriage", () => {
	it("classifies transport-shaped failures as flaky and nothing else", () => {
		expect(looksFlaky("Error: ETIMEDOUT while fetching registry")).toBe(true)
		expect(looksFlaky("npm ERR! 503 Service Unavailable")).toBe(true)
		expect(looksFlaky("context deadline exceeded")).toBe(true)
		expect(looksFlaky("TS2345: Argument of type 'string' is not assignable")).toBe(false)
		expect(looksFlaky("1 test failed: expected 2 to be 3")).toBe(false)
	})

	it("finds the workflow run id in a check's details URL", () => {
		expect(runIdFromDetailsUrl("https://github.com/o/r/actions/runs/12345/job/678")).toBe(12345)
		expect(runIdFromDetailsUrl("https://example.com/nothing")).toBeNull()
	})

	const prRoute = {
		"GET /repos/o/r/pulls?state=open&per_page=100": {
			status: 200,
			data: [{ number: 7, head: { ref: "fix/vuln-undici-7.30.1-x", sha: "deadbeef" } }],
		},
	}

	it("re-runs a transport-shaped failure instead of commenting", async () => {
		const api = fakeApi({
			...prRoute,
			"GET /repos/o/r/commits/deadbeef/check-runs?per_page=100": {
				status: 200,
				data: {
					check_runs: [
						{
							name: "verify",
							conclusion: "failure",
							details_url: "https://github.com/o/r/actions/runs/999/job/1",
							output: { summary: "npm ERR! ETIMEDOUT" },
						},
					],
				},
			},
			"POST /repos/o/r/actions/runs/999/rerun-failed-jobs": { status: 201, data: {} },
		})
		const res = await runTriage({
			api: api as never,
			token: "tok",
			repos: ["o/r"],
			dry: false,
			log: () => {},
		})
		expect(res.rerun).toBe(1)
		expect(res.commented).toBe(0)
		expect(api.calls.some((c) => c.path.includes("/issues/7/comments"))).toBe(false)
	})

	it("comments once on a real failure, and never twice on the same commit", async () => {
		const api = fakeApi({
			...prRoute,
			"GET /repos/o/r/commits/deadbeef/check-runs?per_page=100": {
				status: 200,
				data: {
					check_runs: [
						{
							name: "verify",
							conclusion: "failure",
							details_url: "https://github.com/o/r/actions/runs/999/job/1",
							output: { summary: "TS2345" },
						},
					],
				},
			},
			"GET /repos/o/r/issues/7/comments?per_page=100": { status: 200, data: [] },
			"POST /repos/o/r/issues/7/comments": { status: 201, data: {} },
		})
		const first = await runTriage({
			api: api as never,
			token: "tok",
			repos: ["o/r"],
			dry: false,
			log: () => {},
		})
		expect(first.commented).toBe(1)
		const comment = api.calls.find(
			(c) => c.method === "POST" && c.path.includes("/issues/7/comments"),
		)
		expect(String((comment?.json as { body?: string })?.body)).toContain(
			"<!-- pr-agent:ci-triage:deadbeef -->",
		)

		// Same commit, second pass: the marker is found, so nothing is posted.
		const api2 = fakeApi({
			...prRoute,
			"GET /repos/o/r/commits/deadbeef/check-runs?per_page=100": {
				status: 200,
				data: {
					check_runs: [{ name: "verify", conclusion: "failure", output: { summary: "TS2345" } }],
				},
			},
			"GET /repos/o/r/issues/7/comments?per_page=100": {
				status: 200,
				data: [{ body: "<!-- pr-agent:ci-triage:deadbeef --> already said" }],
			},
		})
		const second = await runTriage({
			api: api2 as never,
			token: "tok",
			repos: ["o/r"],
			dry: false,
			log: () => {},
		})
		expect(second.commented).toBe(0)
	})
})

describe("codeqlWorkflowBody", () => {
	it("substitutes the language matrix and never leaves the placeholder", () => {
		// THE BUG THIS GUARDS: the template's own comment mentioned the placeholder
		// token, so a bare `String.replace` substituted the COMMENT and left
		// `language: [__LANGUAGES__]` in the matrix — 20 repos got an unparseable
		// workflow while the sync reported success for each one.
		const template = readFileSync(
			join(import.meta.dirname, "..", "src", "ops", "templates", "codeql.yml"),
			"utf8",
		)
		const body = codeqlWorkflowBody(template, ["javascript-typescript", "python"])
		expect(body).toContain('language: ["javascript-typescript", "python"]')
		expect(body).not.toContain("__LANGUAGES__")
	})

	it("never leaves the token behind, even with nothing to substitute", () => {
		// The invariant is "no placeholder in the output", not "throw on empty":
		// `replaceAll` handles both occurrences, and an empty list produces an empty
		// matrix rather than a body that cannot parse.
		expect(codeqlWorkflowBody("language: [__LANGUAGES__]", [])).toBe("language: []")
	})
})

describe("codeScanningVerdict", () => {
	it("refuses a private repo with no GHAS, which is the case that reddened CI", () => {
		// MEASURED: MythEclipse/web1 and MythEclipse/tracerstudy-siuinjambi are
		// private, have no GHAS, and got codeql.yml from the sync anyway. The
		// `analyze` step then failed on every push and every weekly schedule from
		// 2026-11-17 onward — a red nobody could clear.
		const verdict = codeScanningVerdict({ isPrivate: true, advancedSecurityEnabled: false })
		expect(verdict.allowed).toBe(false)
		expect(verdict.reason).toContain("Advanced Security")
	})

	it("allows a public repo, because code scanning is free there", () => {
		// The other half of the same measurement: 42 public repos were green with
		// the identical workflow, so `private` is the discriminator — not
		// `advanced_security`, which is absent from ALL 48 repos.
		expect(codeScanningVerdict({ isPrivate: false, advancedSecurityEnabled: false }).allowed).toBe(
			true,
		)
	})

	it("allows a private repo once GHAS is actually enabled", () => {
		// The case the account does not have yet, and the reason the flag is
		// checked BEFORE `private`: buying GHAS must re-enable scanning without a
		// code change.
		expect(codeScanningVerdict({ isPrivate: true, advancedSecurityEnabled: true }).allowed).toBe(
			true,
		)
	})
})

describe("codeqlLanguagesFor", () => {
	it("maps what a repo actually contains, and skips what CodeQL cannot scan", () => {
		expect(codeqlLanguagesFor(["package.json", "README.md"])).toEqual(["javascript-typescript"])
		expect(codeqlLanguagesFor(["pyproject.toml"])).toEqual(["python"])
		expect(codeqlLanguagesFor(["package.json", "requirements.txt"])).toEqual([
			"javascript-typescript",
			"python",
		])
		// Rust and PHP have no CodeQL extractor: a workflow would fail every push.
		expect(codeqlLanguagesFor(["Cargo.toml"])).toEqual([])
		expect(codeqlLanguagesFor(["composer.json"])).toEqual([])
	})
})

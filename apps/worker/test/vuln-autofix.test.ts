import { describe, expect, it } from "vitest"
import type { GitResult } from "../src/git.ts"
import { listAllOwnedRepos, toOwnedRepo } from "../src/ops/repoList.ts"
import type { DependabotAlert } from "../src/ops/security.ts"
import {
	alertUrl,
	buildVulnPrBody,
	compareVersions,
	dependabotUrl,
	directoryOf,
	fixCommandFor,
	planVulnFixes,
	runVulnAutofix,
	type VulnFixPlan,
	vulnBranchName,
} from "../src/ops/vulnAutofix.ts"

const alert = (over: Partial<DependabotAlert> & { number: number }): DependabotAlert => ({
	state: "open",
	dependency: {
		package: { ecosystem: "npm", name: "lodash" },
		manifest_path: "package-lock.json",
	},
	security_advisory: {
		ghsa_id: "GHSA-aaaa-bbbb-cccc",
		cve_id: null,
		summary: "prototype pollution",
		severity: "high",
	},
	security_vulnerability: {
		package: { ecosystem: "npm", name: "lodash" },
		severity: "high",
		vulnerable_version_range: "< 4.17.21",
		first_patched_version: { identifier: "4.17.21" },
	},
	url: "https://api.github.com/repos/o/r/dependabot/alerts/1",
	html_url: "https://github.com/o/r/security/dependabot/1",
	created_at: "2026-11-01T00:00:00Z",
	...over,
})

describe("listAllOwnedRepos", () => {
	it("reads every page, not just the first hundred", async () => {
		// THE BUG THIS REPLACES: one page of 100 and stop. Repo 101 onwards got
		// no Dependabot config, no vulnerability alerts and no security PRs, and
		// the count the callers printed looked like a complete fleet.
		const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}` }))
		const page2 = [{ full_name: "o/last" }]
		const calls: string[] = []
		// PARSE the page number, never substring-match it: every URL here carries
		// `per_page=100`, which itself contains `page=1`.
		const pageOf = (p: string): number => Number(/[?&]page=(\d+)/.exec(p)?.[1] ?? "0")
		const api = {
			async request(_m: string, path: string) {
				calls.push(path)
				const page = pageOf(path)
				return { status: 200, data: page === 1 ? page1 : page === 2 ? page2 : [] }
			},
		}

		const got = await listAllOwnedRepos(api, "tok")

		expect(got.ok).toBe(true)
		expect(got.repos).toHaveLength(101)
		expect(got.repos.at(-1)?.fullName).toBe("o/last")
		expect(calls.some((c) => c.includes("page=2"))).toBe(true)
	})

	it("a failed page is NOT a smaller fleet", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}` }))
		const pageOf = (p: string): number => Number(/[?&]page=(\d+)/.exec(p)?.[1] ?? "0")
		const api = {
			async request(_m: string, path: string) {
				return pageOf(path) === 1 ? { status: 200, data: page1 } : { status: 502, data: {} }
			},
		}

		const got = await listAllOwnedRepos(api, "tok")

		// The repos already read are still returned — they are real work — but the
		// result says the walk did not finish, so no caller can report "the fleet".
		expect(got.ok).toBe(false)
		expect(got).toMatchObject({ status: 502 })
		expect(got.repos).toHaveLength(100)
	})

	it("a repeated row does not become two syncs", async () => {
		// `sort=full_name` is stable but a repo created between two page requests
		// shifts the window, so a row can appear on both pages.
		const full = Array.from({ length: 100 }, (_, i) => ({ full_name: `o/r${i}` }))
		const pageOf = (p: string): number => Number(/[?&]page=(\d+)/.exec(p)?.[1] ?? "0")
		const api = {
			async request(_m: string, path: string) {
				return { status: 200, data: pageOf(path) === 1 ? full : [{ full_name: "o/r0" }] }
			},
		}
		const got = await listAllOwnedRepos(api, "tok")
		expect(got.repos).toHaveLength(100)
	})

	it("archived and disabled repos are dropped, not reported as in sync", () => {
		expect(toOwnedRepo({ full_name: "o/a", archived: true })).toBeNull()
		expect(toOwnedRepo({ full_name: "o/b", disabled: true })).toBeNull()
		expect(toOwnedRepo({ full_name: "o/c" })).toEqual({ fullName: "o/c", defaultBranch: "main" })
		expect(toOwnedRepo({ full_name: "o/d", default_branch: "trunk" })).toEqual({
			fullName: "o/d",
			defaultBranch: "trunk",
		})
		expect(toOwnedRepo({})).toBeNull()
	})
})

describe("planVulnFixes", () => {
	it("groups one plan per (manifest, package), keeping the highest patch", () => {
		const alerts = [
			alert({ number: 1 }),
			// Same package, a later advisory with a HIGHER patched version: taking
			// the lower one would leave the second advisory open.
			alert({
				number: 2,
				security_advisory: {
					ghsa_id: "GHSA-dddd-eeee-ffff",
					cve_id: null,
					summary: "x",
					severity: "critical",
				},
				security_vulnerability: {
					package: { ecosystem: "npm", name: "lodash" },
					severity: "critical",
					vulnerable_version_range: "< 4.17.22",
					first_patched_version: { identifier: "4.17.22" },
				},
			}),
		]
		const plans = planVulnFixes("o/r", alerts)
		expect(plans).toHaveLength(1)
		expect(plans[0]).toMatchObject({
			packageName: "lodash",
			patchedVersion: "4.17.22",
			severity: "critical",
			alertNumbers: [1, 2],
			ghsaIds: ["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"],
		})
	})

	it("the same package on two manifests is two units of work", () => {
		const plans = planVulnFixes("o/r", [
			alert({ number: 1 }),
			alert({
				number: 2,
				dependency: {
					package: { ecosystem: "npm", name: "lodash" },
					manifest_path: "apps/web/package-lock.json",
				},
			}),
		])
		expect(plans.map((p) => p.directory).sort()).toEqual(["/", "/apps/web"])
	})

	it("an alert with no patched version is not a plan", () => {
		// Nothing to upgrade to: the lane is fine, the release does not exist yet.
		const plans = planVulnFixes("o/r", [
			alert({
				number: 3,
				security_vulnerability: {
					package: { ecosystem: "npm", name: "lodash" },
					severity: "high",
					vulnerable_version_range: "< 9",
					first_patched_version: null,
				},
			}),
		])
		expect(plans).toEqual([])
	})

	it("directoryOf gives the update command a real cwd", () => {
		expect(directoryOf("package-lock.json")).toBe("/")
		expect(directoryOf("apps/web/package-lock.json")).toBe("/apps/web")
		expect(directoryOf("/leading/package-lock.json")).toBe("/leading")
	})

	it("compareVersions orders numerically, not lexically", () => {
		expect(compareVersions("4.17.21", "4.17.9")).toBe(1)
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0)
		expect(compareVersions("1.2.3-rc.1", "1.2.3")).toBe(-1)
		expect(compareVersions("v2.0.0", "1.9.9")).toBe(1)
	})
})

describe("fixCommandFor", () => {
	const plan = (manifestPath: string, ecosystem = "npm"): VulnFixPlan => ({
		repo: "o/r",
		ecosystem,
		manifestPath,
		directory: directoryOf(manifestPath),
		packageName: "lodash",
		patchedVersion: "4.17.21",
		severity: "high",
		alertNumbers: [1],
		ghsaIds: ["GHSA-aaaa-bbbb-cccc"],
		transitive: false,
	})

	it("rewrites the lockfile without installing node_modules", () => {
		expect(fixCommandFor(plan("package-lock.json"))).toEqual({
			argv: [
				"npm",
				"install",
				"--package-lock-only",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"lodash@4.17.21",
			],
			fallback: [
				"npm",
				"install",
				"--package-lock-only",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"lodash@4.17.21",
				"--legacy-peer-deps",
			],
		})
		expect(fixCommandFor(plan("pnpm-lock.yaml"))).toEqual({
			argv: ["pnpm", "update", "lodash@4.17.21", "--lockfile-only", "--ignore-scripts"],
		})
		expect(fixCommandFor(plan("Cargo.lock", "rust"))).toEqual({
			argv: ["cargo", "update", "-p", "lodash", "--precise", "4.17.21"],
		})
		expect(fixCommandFor(plan("composer.lock", "composer"))).toEqual({
			argv: [
				"composer",
				"update",
				"lodash",
				"--with-dependencies",
				"--no-interaction",
				"--no-scripts",
			],
		})
	})

	it("yarn needs the form its major version actually has", () => {
		// Yarn 1 has no `up`; Berry has no `upgrade`. Guessing wrong exits 0
		// without touching the lockfile, which the diff check then reports as
		// "nothing to fix".
		expect(fixCommandFor(plan("yarn.lock"), { yarnBerry: true })).toEqual({
			argv: ["yarn", "up", "lodash@4.17.21"],
		})
		expect(fixCommandFor(plan("yarn.lock"))).toEqual({
			argv: ["yarn", "upgrade", "lodash@4.17.21"],
		})
	})

	it("an ecosystem with no single-command update is MANUAL, not attempted", () => {
		const maven = fixCommandFor(plan("pom.xml", "maven"))
		expect("manual" in maven).toBe(true)
		expect(fixCommandFor(plan("requirements.txt", "pip"))).toHaveProperty("manual")
	})
})

describe("branch names, URLs and PR body", () => {
	const plan: VulnFixPlan = {
		repo: "MythEclipse/BotWa",
		ecosystem: "npm",
		manifestPath: "package-lock.json",
		directory: "/",
		packageName: "@babel/traverse",
		patchedVersion: "7.23.2",
		severity: "critical",
		alertNumbers: [12, 13],
		ghsaIds: ["GHSA-67hx-6x53-jw92"],
		transitive: false,
	}

	it("a scoped package becomes a branch name GitHub accepts", () => {
		expect(vulnBranchName(plan)).toBe("fix/vuln-babel-traverse-7.23.2")
		expect(vulnBranchName(plan)).not.toContain("@")
		expect(vulnBranchName(plan)).not.toContain("//")
	})

	it("the body links the alerts and the Dependabot page", () => {
		const body = buildVulnPrBody(plan)
		expect(body).toContain(alertUrl("MythEclipse/BotWa", 12))
		expect(body).toContain(alertUrl("MythEclipse/BotWa", 13))
		expect(body).toContain(dependabotUrl("MythEclipse/BotWa"))
		expect(body).toContain("GHSA-67hx-6x53-jw92")
		expect(body).toContain("7.23.2")
		// The reviewer must be able to reproduce the bump by hand.
		expect(body).toContain("npm install --package-lock-only")
	})

	it("a Yarn Berry repo is told to run `yarn up`, not `yarn upgrade`", async () => {
		// `fixCommandFor` has always had a `yarnBerry` option, but NOTHING passed
		// it — so every Berry repo (which pins `packageManager: "yarn@4.x"`) was
		// run with Yarn 1's `yarn upgrade`. Berry treats that as an unknown
		// command that exits 0 WITHOUT touching the lockfile, and the no-diff
		// check then reported "resolved nothing" on a repo that was fixable.
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "npm", name: "lodash" },
						manifest_path: "yarn.lock",
					},
				}),
			],
			// The clone is removed before it is recreated, so the manifest must come
			// from the fake's default rather than a pre-seeded file.
			packageManager: "yarn@4.1.0",
			// The lockfile moved, so the diff check passes.
			diff: " M yarn.lock\n",
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["MythEclipse/BotWa"] })

		expect(summary.opened).toBe(1)
		expect(h.execCalls[0]?.slice(0, 2)).toEqual(["yarn", "up"])
		expect(h.execCalls[0]).not.toContain("upgrade")
	})

	it("two manifests for ONE package get DIFFERENT branches", () => {
		// THE BUG THIS PINS. A plan is one (manifest, package) pair, but the branch
		// used to be `pkg@version` alone. The same package on `package-lock.json`
		// and `apps/web/package-lock.json` therefore produced ONE branch: the first
		// PR opened, and the second plan found it via `openPrForBranch` and reported
		// "already open" — so the second manifest was never fixed and the report
		// claimed it was. That is the silent half-fix the grouping rule forbids.
		const root: VulnFixPlan = { ...plan, manifestPath: "package-lock.json", directory: "/" }
		const nested: VulnFixPlan = {
			...plan,
			manifestPath: "apps/web/package-lock.json",
			directory: "/apps/web",
		}
		expect(vulnBranchName(root)).toBe("fix/vuln-babel-traverse-7.23.2")
		expect(vulnBranchName(nested)).not.toBe(vulnBranchName(root))
		expect(vulnBranchName(nested)).toMatch(/^fix\/vuln-babel-traverse-7\.23\.2-[0-9a-f]{8}$/)
		// Stable across calls: a re-run must find the SAME branch, not a new one.
		expect(vulnBranchName(nested)).toBe(vulnBranchName(nested))
	})

	it("the URLs are the ones a human opens", () => {
		expect(dependabotUrl("MythEclipse/BotWa")).toBe(
			"https://github.com/MythEclipse/BotWa/security/dependabot",
		)
		expect(alertUrl("MythEclipse/BotWa", 7)).toBe(
			"https://github.com/MythEclipse/BotWa/security/dependabot/7",
		)
	})
})

// ── The orchestrator, with every effect injected ─────────────────────────────

type Recorded = { method: string; path: string; json?: unknown }

function harness(opts: {
	alerts?: DependabotAlert[]
	alertsStatus?: number
	existingPr?: number
	/** Per-branch override: return a PR number when that head already has one. */
	existingPrFor?: (path: string) => number | undefined
	diff?: string
	pushOk?: boolean
	prStatus?: number
	defaultBranch?: string
	/** Queued results for successive `exec` calls; the last one repeats. */
	execResults?: GitResult[]
	/** Files the fake filesystem starts with, keyed by absolute path. */
	files?: Record<string, string>
	/** The `packageManager` field the default `package.json` reports. */
	packageManager?: string
}) {
	const requests: Recorded[] = []
	const gitCalls: string[][] = []
	const execCalls: string[][] = []
	const workdirs = new Map<string, string>(Object.entries(opts.files ?? {}))
	const api = {
		async request(method: string, path: string, o?: { token?: string; json?: unknown }) {
			requests.push({ method, path, json: o?.json })
			if (path.includes("/dependabot/alerts")) {
				const status = opts.alertsStatus ?? 200
				return status === 200 ? { status, data: opts.alerts ?? [] } : { status, data: {} }
			}
			if (path.includes("/pulls?state=open&head=")) {
				const n = opts.existingPrFor?.(path) ?? opts.existingPr
				return { status: 200, data: n ? [{ number: n }] : [] }
			}
			if (method === "POST" && path.endsWith("/pulls")) {
				return { status: opts.prStatus ?? 201, data: { number: 77 } }
			}
			// GET /repos/{repo}
			return { status: 200, data: { default_branch: opts.defaultBranch ?? "main" } }
		},
	}
	const run = (args: string[]): GitResult => {
		gitCalls.push(args)
		if (args[0] === "clone" || args[0] === "config") return { code: 0, stdout: "", stderr: "" }
		if (args[0] === "status") {
			return { code: 0, stdout: opts.diff ?? " M package-lock.json\n", stderr: "" }
		}
		if (args[0] === "commit") return { code: 0, stdout: "", stderr: "" }
		if (args[0] === "push") {
			return opts.pushOk === false
				? { code: 1, stdout: "", stderr: "! [rejected] main -> main" }
				: { code: 0, stdout: "", stderr: "" }
		}
		return { code: 0, stdout: "", stderr: "" }
	}
	const exec = (args: string[]): GitResult => {
		execCalls.push(args)
		const queued = opts.execResults
		if (queued?.length)
			return queued.length > 1 ? (queued.shift() as GitResult) : (queued[0] as GitResult)
		return { code: 0, stdout: "", stderr: "" }
	}
	const lines: string[] = []
	const deps = {
		api: api as never,
		run: run as never,
		exec: exec as never,
		workdirs: {
			exists: (p: string) => workdirs.has(p),
			mkdir: (p: string) => workdirs.set(p, ""),
			remove: (p: string) => workdirs.delete(p),
			writeFile: (p: string, c: string) => workdirs.set(p, c),
			readFile: (p: string) => {
				const v = workdirs.get(p)
				if (v !== undefined) return v
				// Defaults for the npm flows, which now read the repo's own manifest
				// and lockfile to tell a direct dependency from a transitive one:
				// `lodash` declared at ^4.17.0 and installed at 4.17.0, so the usual
				// "bump it forward" case is exercised unless a test seeds otherwise.
				if (p.endsWith("/package.json")) {
					const manifest: Record<string, unknown> = { dependencies: { lodash: "^4.17.0" } }
					if (opts.packageManager) manifest.packageManager = opts.packageManager
					return JSON.stringify(manifest)
				}
				if (p.endsWith("/package-lock.json")) {
					return JSON.stringify({ packages: { "node_modules/lodash": { version: "4.17.0" } } })
				}
				throw new Error(`ENOENT: ${p}`)
			},
		},
		fetchGhToken: () => "",
		dry: false,
		report: (l: string) => lines.push(l),
	}
	return { deps, requests, gitCalls, execCalls, lines }
}

describe("runVulnAutofix", () => {
	it("bumps, pushes and opens the PR", async () => {
		const h = harness({ alerts: [alert({ number: 1 })] })
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(1)
		expect(summary.failed).toBe(0)
		// The ecosystem's own command ran, in the manifest's directory.
		expect(h.execCalls[0]?.[0]).toBe("npm")
		expect(h.execCalls[0]).toContain("lodash@4.17.21")
		// A branch was pushed and a PR opened against the default branch.
		const push = h.gitCalls.find((c) => c[0] === "push")
		expect(push?.join(" ")).toContain("refs/heads/fix/vuln-lodash-4.17.21")
		const pr = h.requests.find((r) => r.method === "POST")
		expect(pr?.json).toMatchObject({ head: "fix/vuln-lodash-4.17.21", base: "main" })
		expect(h.lines.join("\n")).toContain("https://github.com/o/r/pull/77")
		// The clone does not leak: the workdir is removed on the way out.
		expect(h.deps.workdirs.exists("/tmp/pr-queue-work/_vuln_o_r_lodash-4.17.21")).toBe(false)
	})

	it("an update that changes nothing opens NO PR", async () => {
		// The command can exit 0 and leave the lockfile alone. A PR from that
		// claims a remediation the branch does not contain, and the alert stays
		// open with a "fix" attached to it.
		const h = harness({ alerts: [alert({ number: 1 })], diff: "" })
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(0)
		expect(summary.failed).toBe(0)
		expect(summary.manual).toBe(1)
		expect(h.gitCalls.some((c) => c[0] === "push")).toBe(false)
		expect(h.requests.some((r) => r.method === "POST")).toBe(false)
		expect(h.lines.join("\n")).toContain("resolved nothing")
	})

	it("a plan whose PR already exists does NOT consume the per-repo cap", async () => {
		// THE STARVATION BUG. The cap bounds PRs OPENED per run, but it used to be
		// incremented for every plan the loop looked at — including the ones that
		// were skipped because their PR already existed. A repo whose first N plans
		// were already open therefore "spent" the whole budget without opening
		// anything, the rest were deferred, and the next run repeated the same N.
		// The genuinely unfixed alerts behind them never got a PR, on any run.
		const alerts = ["a", "b", "c"].map((pkg, i) =>
			alert({
				number: i + 1,
				dependency: {
					package: { ecosystem: "npm", name: pkg },
					manifest_path: "package-lock.json",
				},
			}),
		)
		const h = harness({
			alerts,
			// `a` and `b` already have PRs; `c` does not and must be reached.
			existingPrFor: (path) =>
				path.includes("fix/vuln-a-") ? 10 : path.includes("fix/vuln-b-") ? 11 : undefined,
		})
		await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"], maxPrsPerRepo: 1 })

		// `c` must actually be worked on: a POST for its branch, and no "left for
		// the next run" (which is what the starving loop printed instead).
		const posted = h.requests
			.filter((r) => r.method === "POST" && r.path.endsWith("/pulls"))
			.map((r) => JSON.stringify(r.json))
		expect(posted.some((j) => j.includes("fix/vuln-c-"))).toBe(true)
		expect(h.lines.join("\n")).not.toContain("left for the next run")
	})

	it("a package that already has an open PR is skipped, not re-cloned", async () => {
		const h = harness({ alerts: [alert({ number: 1 })], existingPr: 5 })
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(1) // the work is done, by someone
		expect(h.gitCalls.some((c) => c[0] === "clone")).toBe(false)
		expect(h.lines.join("\n")).toContain("PR #5")
	})

	it("an unreadable alert list is a failure, never a clean repo", async () => {
		const h = harness({ alertsStatus: 403 })
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.failed).toBe(1)
		expect(summary.perRepo[0]).toMatchObject({ repo: "o/r", unreadable: true })
		expect(h.lines.join("\n")).toContain("HTTP 403")
	})

	it("a maven alert is reported as MANUAL, not attempted", async () => {
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "maven", name: "mysql:mysql-connector-java" },
						manifest_path: "pom.xml",
					},
				}),
			],
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.manual).toBe(1)
		expect(summary.opened).toBe(0)
		expect(h.execCalls).toEqual([])
	})

	it("dry run reports the plan and touches nothing", async () => {
		const h = harness({ alerts: [alert({ number: 1 })] })
		h.deps.dry = true
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(0)
		expect(h.execCalls).toEqual([])
		expect(h.gitCalls.some((c) => c[0] === "clone")).toBe(false)
		expect(h.lines.join("\n")).toContain("would bump lodash -> 4.17.21")
	})

	it("the per-repo cap leaves the rest for the next run", async () => {
		const alerts = Array.from({ length: 8 }, (_, i) =>
			alert({
				number: i + 1,
				dependency: {
					package: { ecosystem: "npm", name: `pkg${i}` },
					manifest_path: "package-lock.json",
				},
			}),
		)
		const h = harness({ alerts })
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"], maxPrsPerRepo: 2 })

		expect(summary.opened).toBe(2)
		expect(h.lines.join("\n")).toContain("left for the next run")
	})

	it("a TRANSITIVE npm advisory is pinned with overrides, not promoted to a dependency", async () => {
		// MEASURED on BotWa: `npm install --package-lock-only brace-expansion@1.1.21`
		// satisfies the advisory by ADDING `"brace-expansion": "^1.1.21"` to
		// `dependencies` — it promotes a transitive package to a direct one, which
		// changes the repo's dependency contract. `--no-save` is not the answer
		// either (measured: "up to date", lockfile untouched, so the "fix" fixes
		// nothing). `overrides` is npm's own idiom for this case.
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "npm", name: "brace-expansion" },
						manifest_path: "package-lock.json",
						relationship: "transitive",
					},
					security_vulnerability: {
						package: { ecosystem: "npm", name: "brace-expansion" },
						severity: "high",
						vulnerable_version_range: "< 1.1.21",
						first_patched_version: { identifier: "1.1.21" },
					},
				}),
			],
			files: {
				"/tmp/pr-queue-work/_vuln_o_r_brace-expansion-1.1.21/package.json":
					'{\n	"name": "r",\n	"dependencies": {\n		"minimatch": "^3.1.2"\n	}\n}\n',
			},
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })
		expect(summary.opened).toBe(1)
		// The override is what drives resolution, so the command takes no package arg.
		expect(h.execCalls[0]).toEqual([
			"npm",
			"install",
			"--package-lock-only",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
		])
		const written = JSON.parse(
			h.deps.workdirs.readFile("/tmp/pr-queue-work/_vuln_o_r_brace-expansion-1.1.21/package.json"),
		)
		expect(written.overrides).toEqual({ "brace-expansion": "1.1.21" })
		// The file's own indentation survives: a re-serialised whole file hides the
		// two lines that matter (measured on BotWa, four spaces in, tabs out).
		expect(
			h.deps.workdirs.readFile("/tmp/pr-queue-work/_vuln_o_r_brace-expansion-1.1.21/package.json"),
		).toContain('\n	"name"')
		// The dependency list is untouched — that is the whole point.
		expect(written.dependencies).toEqual({ minimatch: "^3.1.2" })
		expect(JSON.stringify(h.requests.find((r) => r.method === "POST")?.json)).toContain(
			"Pinned with",
		)
	})

	it("refuses to DOWNGRADE a direct dependency whose vulnerable copy is nested", async () => {
		// MEASURED, and it shipped once: BotWa's `axios` was a direct `^1.21.1`
		// while the advisories were on 0.x copies nested under `dhn-api` and
		// `wa-sticker-formatter`. `npm install axios@0.33.0` rewrote the DIRECT
		// range to `^0.33.0` — a downgrade of the package the app itself imports —
		// and left the nested copies untouched. CI was green, so it merged.
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "npm", name: "axios" },
						manifest_path: "package-lock.json",
					},
					security_vulnerability: {
						package: { ecosystem: "npm", name: "axios" },
						severity: "high",
						vulnerable_version_range: "< 0.33.0",
						first_patched_version: { identifier: "0.33.0" },
					},
				}),
			],
			files: {
				"/tmp/pr-queue-work/_vuln_o_r_axios-0.33.0/package.json":
					'{"dependencies":{"axios":"^1.21.1"}}',
				"/tmp/pr-queue-work/_vuln_o_r_axios-0.33.0/package-lock.json": JSON.stringify({
					packages: { "node_modules/axios": { version: "1.21.1" } },
				}),
			},
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.manual).toBe(1)
		expect(summary.opened).toBe(0)
		// npm is never run: the decision is made before touching the tree.
		expect(h.execCalls).toEqual([])
		expect(h.lines.join("\n")).toContain("DOWNGRADE")
	})

	it("refuses to move a direct dependency when its installed version is unreadable", async () => {
		// `npmLockedVersion` documents null as "do not move it", but the guard only
		// refused when the version was READABLE and not ahead. An absent or
		// unparseable lockfile therefore fell through to `npm install <pkg>@<ver>`,
		// which rewrites the DECLARED range — on a direct dependency that can be a
		// downgrade of the package the app imports (the BotWa `axios` shape), on no
		// evidence at all.
		const h = harness({
			alerts: [alert({ number: 1 })],
			files: {
				"/tmp/pr-queue-work/_vuln_o_r_lodash-4.17.21/package.json":
					'{"dependencies":{"lodash":"^4.17.0"}}',
				// A lockfile that is not JSON, i.e. "cannot tell".
				"/tmp/pr-queue-work/_vuln_o_r_lodash-4.17.21/package-lock.json": "{not json",
			},
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(0)
		expect(summary.manual).toBe(1)
		expect(h.execCalls).toEqual([])
		expect(h.lines.join("\n")).toContain("could not be read")
	})

	it("the peer-conflict retry keeps the override route", async () => {
		// MEASURED on BotWa #24: the override landed AND `"brace-expansion":
		// "^1.1.21"` was added to `dependencies`, because the retry carried the
		// ORIGINAL `npm install <pkg>@<ver>` argv — the promotion the override
		// exists to avoid.
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "npm", name: "brace-expansion" },
						manifest_path: "package-lock.json",
						relationship: "transitive",
					},
					security_vulnerability: {
						package: { ecosystem: "npm", name: "brace-expansion" },
						severity: "high",
						vulnerable_version_range: "< 1.1.21",
						first_patched_version: { identifier: "1.1.21" },
					},
				}),
			],
			files: {
				"/tmp/pr-queue-work/_vuln_o_r_brace-expansion-1.1.21/package.json": '{\n	"name": "r"\n}\n',
			},
			execResults: [
				{ code: 1, stdout: "", stderr: "npm error code ERESOLVE" },
				{ code: 0, stdout: "", stderr: "" },
			],
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(1)
		// The retry must NOT name the package: naming it is what promotes it.
		expect(h.execCalls[1]).toEqual([
			"npm",
			"install",
			"--package-lock-only",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--legacy-peer-deps",
		])
	})

	it("an override that leaves the lockfile alone is NOT a fix", async () => {
		// Writing the override dirties package.json, so "any change" would pass.
		// Only a moved LOCKFILE counts.
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "npm", name: "brace-expansion" },
						manifest_path: "package-lock.json",
						relationship: "transitive",
					},
					security_vulnerability: {
						package: { ecosystem: "npm", name: "brace-expansion" },
						severity: "high",
						vulnerable_version_range: "< 1.1.21",
						first_patched_version: { identifier: "1.1.21" },
					},
				}),
			],
			files: {
				"/tmp/pr-queue-work/_vuln_o_r_brace-expansion-1.1.21/package.json": '{ "name": "r" }\n',
			},
			diff: " M package.json\n",
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(0)
		expect(summary.manual).toBe(1)
		expect(h.gitCalls.some((c) => c[0] === "push")).toBe(false)
	})

	it("an npm peer conflict is retried once with --legacy-peer-deps", async () => {
		// MEASURED: BotWa's `axios` bump dies with `ERESOLVE could not resolve …
		// baileys@6.17.16 … jimp@1.6.1` — a pre-existing peer conflict between two
		// packages unrelated to the advisory. Without the retry, 88 fixable alerts
		// on that repo stay unfixable.
		const h = harness({
			alerts: [alert({ number: 1 })],
			execResults: [
				{ code: 1, stdout: "", stderr: "npm error code ERESOLVE\nnpm error could not resolve" },
				{ code: 0, stdout: "", stderr: "" },
			],
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(1)
		expect(h.execCalls[1]).toContain("--legacy-peer-deps")
		const pr = h.requests.find((r) => r.method === "POST")
		// The reviewer is told the resolution needed a flag, and CI still has to
		// install it — that is the safety net, not this code.
		expect(JSON.stringify(pr?.json)).toContain("legacy-peer-deps")
	})

	it("a pnpm transitive dependency is MANUAL, not a retried failure", async () => {
		// MEASURED on Pemrograman-web-1's `minimatch`: pnpm refuses to pin a
		// version for a transitive dependency, and there is no lockfile-scoped way
		// around it. Reported as a human decision, not as a broken run.
		const h = harness({
			alerts: [alert({ number: 1 })],
			execResults: [
				{
					code: 1,
					stdout: "",
					stderr:
						'ERR_PNPM_UPDATE_VERSION_ON_INDIRECT_DEP  "minimatch" (requested "11.0.1") is not a direct dependency',
				},
			],
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.manual).toBe(1)
		expect(summary.failed).toBe(0)
		expect(h.lines.join("\n")).toContain("TRANSITIVE dependency")
	})

	it("a missing tool is reported as a HOST problem, not a lockfile one", async () => {
		// `composer` is not installed on every host that runs the worker. "composer
		// exited 127" sends the reader to the repo; the fix is an install here.
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "composer", name: "phpunit/phpunit" },
						manifest_path: "composer.lock",
					},
				}),
			],
			execResults: [{ code: 127, stdout: "", stderr: "Error: spawnSync composer ENOENT" }],
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.failed).toBe(1)
		expect(h.lines.join("\n")).toContain("not installed on this host")
	})

	it("a timeout is reported as a budget, not as a broken tool", async () => {
		const h = harness({
			alerts: [alert({ number: 1 })],
			execResults: [{ code: 124, stdout: "", stderr: "timeout after 900s" }],
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.failed).toBe(1)
		expect(h.lines.join("\n")).toContain("timed out after 900s")
	})

	it("a failed push is a failure, and no PR is attempted", async () => {
		const h = harness({ alerts: [alert({ number: 1 })], pushOk: false })
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.failed).toBe(1)
		expect(h.requests.some((r) => r.method === "POST")).toBe(false)
	})
})

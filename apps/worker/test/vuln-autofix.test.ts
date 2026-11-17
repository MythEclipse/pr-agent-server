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
	lockedVersionsOf,
	lockPackageCount,
	npmRange,
	planVulnFixes,
	runVulnAutofix,
	type VulnFixPlan,
	vulnBranchName,
	writeForcedVersion,
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

describe("npmRange", () => {
	it("converts an advisory's comma-separated range into npm's space form", () => {
		// THE BUG: GitHub writes `>= 7.0.0, < 11.0.1`. npm's override selector is a
		// single whitespace-conjoined range, and the comma form is NOT rejected — it
		// silently matches nothing and npm rewrites the lockfile as an empty stub.
		// Measured on MythEclipse/web1#24: 421 packages -> 0, exit 0, "up to date".
		expect(npmRange(">= 7.0.0, < 11.0.1")).toBe(">= 7.0.0 < 11.0.1")
		expect(npmRange("<11.0.1")).toBe("<11.0.1")
		expect(npmRange(">= 7.0.0,< 11.0.1")).toBe(">= 7.0.0 < 11.0.1")
	})
})

describe("lockPackageCount", () => {
	it("counts npm and pnpm lockfiles, and refuses to guess at anything else", () => {
		const workdirs = (text: string) => ({ readFile: () => text }) as never
		expect(
			lockPackageCount(
				workdirs(JSON.stringify({ packages: { a: {}, b: {} } })),
				"package-lock.json",
			),
		).toBe(2)
		expect(lockPackageCount(workdirs("packages:\n  /a: {}\n  /b: {}\n"), "pnpm-lock.yaml")).toBe(2)
		expect(lockPackageCount(workdirs('[[package]]\nname = "a"\n'), "Cargo.lock")).toBe(1)
		// A format it cannot count answers null, which DISABLES the destruction
		// check rather than guessing — a wrong count would either block every
		// legitimate update or wave a destroyed lockfile through.
		expect(lockPackageCount(workdirs("anything"), "go.sum")).toBeNull()
	})
})

describe("writeForcedVersion", () => {
	const pkgJson = (over: Record<string, unknown> = {}): string =>
		`${JSON.stringify({ name: "r", dependencies: { express: "^4.0.0" }, ...over }, null, 2)}\n`

	it("writes pnpm's overrides into pnpm-workspace.yaml, where pnpm 10+ reads them", () => {
		// MEASURED on the box's pnpm 12.16.1: `pnpm.overrides` in package.json is
		// IGNORED — "[WARN] The pnpm field in package.json is no longer read by
		// pnpm … keys were ignored" — the install exits 0 and the lockfile does not
		// move. The same entry under `overrides:` in pnpm-workspace.yaml moved
		// minimatch from 10.2.6 to 11.0.1.
		const out = writeForcedVersion(pkgJson(), "pnpm-lock.yaml", "minimatch", "11.0.1")
		expect(out?.target).toBe("pnpm-workspace.yaml")
		expect(out?.text).toBe("overrides:\n  minimatch: 11.0.1\n")
	})

	it("still writes pnpm.overrides for a repo that declares pnpm 9", () => {
		// pnpm 9 does not read the workspace file's settings, so a repo that pins
		// its own major keeps the field its major understands.
		const out = writeForcedVersion(
			pkgJson({ pnpm: { onlyBuiltDependencies: ["esbuild"], overrides: { undici: "7.30.1" } } }),
			"pnpm-lock.yaml",
			"minimatch",
			"11.0.1",
			{ packageManager: "pnpm@9.15.0" },
		)
		expect(out?.target).toBe("package.json")
		const manifest = JSON.parse(out?.text ?? "{}") as {
			pnpm?: { onlyBuiltDependencies?: string[]; overrides?: Record<string, string> }
		}
		expect(manifest.pnpm?.onlyBuiltDependencies).toEqual(["esbuild"])
		expect(manifest.pnpm?.overrides).toEqual({ undici: "7.30.1", minimatch: "11.0.1" })
	})

	it("appends to an existing overrides block instead of replacing the file", () => {
		const existing = "packages:\n  - apps/*\nonlyBuiltDependencies:\n  - esbuild\n"
		const out = writeForcedVersion(pkgJson(), "pnpm-lock.yaml", "minimatch", "11.0.1", {
			workspaceYaml: existing,
		})
		expect(out?.text).toBe(`${existing}overrides:\n  minimatch: 11.0.1\n`)
	})

	it("replaces an existing entry rather than stacking a duplicate", () => {
		const existing = "overrides:\n  minimatch: 9.0.5\n  undici: 7.30.1\n"
		const out = writeForcedVersion(pkgJson(), "pnpm-lock.yaml", "minimatch", "11.0.1", {
			workspaceYaml: existing,
		})
		expect(out?.text).toBe("overrides:\n  minimatch: 11.0.1\n  undici: 7.30.1\n")
	})

	it("scopes the key to the advisory range when asked, quoting it in YAML", () => {
		const out = writeForcedVersion(pkgJson(), "pnpm-lock.yaml", "minimatch", "11.0.1", {
			scopeToRange: "<11.0.1",
		})
		expect(out?.key).toBe("minimatch@<11.0.1")
		expect(out?.text).toContain('"minimatch@<11.0.1": 11.0.1')
	})

	it("refuses a SCOPED force on yarn, whose resolutions have no selector", () => {
		// An unscoped `resolutions` entry would pin the direct copy too — the
		// downgrade this flow exists to prevent. Null keeps it as a manual report
		// instead of silently doing the wrong thing.
		expect(
			writeForcedVersion(pkgJson(), "yarn.lock", "minimatch", "11.0.1", { scopeToRange: "<11" }),
		).toBeNull()
		expect(writeForcedVersion(pkgJson(), "yarn.lock", "minimatch", "11.0.1")?.label).toBe(
			"resolutions",
		)
	})

	it("keeps the file's own indentation so the diff is two lines", () => {
		const fourSpace = `{\n    "name": "r"\n}\n`
		const out = writeForcedVersion(fourSpace, "package-lock.json", "axios", "1.2.0")
		expect(out?.text).toContain('\n    "overrides"')
		// No new dependency entry: the override is the whole change.
		expect(JSON.parse(out?.text ?? "{}")).toEqual({ name: "r", overrides: { axios: "1.2.0" } })
	})

	it("returns null for a lockfile format with no override mechanism", () => {
		expect(writeForcedVersion(pkgJson(), "cargo.lock", "glib", "0.20.0")).toBeNull()
		expect(writeForcedVersion("not json", "package-lock.json", "axios", "1.2.0")).toBeNull()
	})
})

describe("lockedVersionsOf", () => {
	const fake = (files: Record<string, string>) =>
		({
			readFile: (p: string) => {
				const v = files[p]
				if (v === undefined) throw new Error(`ENOENT: ${p}`)
				return v
			},
		}) as never

	it("finds a NESTED npm copy, not just the root one", () => {
		// The whole reason the check exists: a vulnerable copy under another package
		// while the root copy is already safe.
		const lock = JSON.stringify({
			packages: {
				"node_modules/minimatch": { version: "11.0.1" },
				"node_modules/glob/node_modules/minimatch": { version: "3.0.4" },
			},
		})
		expect(
			lockedVersionsOf(fake({ "/w/package-lock.json": lock }), "/w/package-lock.json", "minimatch"),
		).toEqual(["11.0.1", "3.0.4"])
	})

	it("finds pnpm's resolved keys, including scoped packages", () => {
		const lock = [
			"lockfileVersion: '9.0'",
			"snapshots:",
			"  minimatch@10.0.1:",
			"    resolution: {integrity: sha512-x}",
			"  '@types/node@26.6.6':",
			"    resolution: {integrity: sha512-y}",
			"",
		].join("\n")
		expect(
			lockedVersionsOf(fake({ "/w/pnpm-lock.yaml": lock }), "/w/pnpm-lock.yaml", "minimatch"),
		).toEqual(["10.0.1"])
		expect(
			lockedVersionsOf(fake({ "/w/pnpm-lock.yaml": lock }), "/w/pnpm-lock.yaml", "@types/node"),
		).toEqual(["26.6.6"])
	})

	it("reads Cargo.lock blocks and composer.lock's package lists", () => {
		// Both are needed for the post-update check: it is what refuses a PR that
		// moved the lockfile without reaching the patch.
		const cargo =
			'[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "glib"\nversion = "0.18.5"\n'
		expect(lockedVersionsOf(fake({ "/w/Cargo.lock": cargo }), "/w/Cargo.lock", "glib")).toEqual([
			"0.18.5",
		])
		const composer = JSON.stringify({
			packages: [{ name: "laravel/framework", version: "v12.0.0" }],
			"packages-dev": [{ name: "phpunit/phpunit", version: "11.5.44" }],
		})
		expect(
			lockedVersionsOf(
				fake({ "/w/composer.lock": composer }),
				"/w/composer.lock",
				"phpunit/phpunit",
			),
		).toEqual(["11.5.44"])
	})

	it("returns null when the format is not one it can read", () => {
		expect(
			lockedVersionsOf(fake({ "/w/Gemfile.lock": "x" }), "/w/Gemfile.lock", "rails"),
		).toBeNull()
		expect(lockedVersionsOf(fake({}), "/w/package-lock.json", "minimatch")).toBeNull()
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
		vulnerableRange: "<4.17.21",
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
		// Composer carries a fallback too, and it is the measured one: `-W` moves
		// the packages that DEPEND on the one being bumped, and
		// `--ignore-platform-req=php` resolves for the repo's declared PHP rather
		// than this host's (AETHRA's paratest refuses php 8.5 outright).
		expect(fixCommandFor(plan("composer.lock", "composer"))).toEqual({
			argv: [
				"composer",
				"update",
				"lodash",
				"--with-dependencies",
				"--no-interaction",
				"--no-scripts",
			],
			fallback: [
				"composer",
				"update",
				"lodash",
				"--with-all-dependencies",
				"--no-interaction",
				"--no-scripts",
				"--ignore-platform-req=php",
			],
			retryOn:
				/does not satisfy that requirement|requires php|conflicts with|locked to version|not satisfiable/i,
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

	it("a uv repo gets a TARGETED re-resolve, not MANUAL", () => {
		// `pr/managers.ts` already re-resolves a uv repo with `uv lock` for the
		// lockfile pre-fix, so reporting uv MANUAL here was an inconsistency, not a
		// policy — a uv repo's alerts could never become a PR. `--upgrade-package`
		// is the targeted form: a bare `uv lock` re-resolves the whole graph.
		expect(fixCommandFor(plan("uv.lock", "pip"))).toEqual({
			argv: ["uv", "lock", "--upgrade-package", "lodash==4.17.21"],
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
		vulnerableRange: "<7.23.2",
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

	it("an override PR body does NOT tell the reviewer to run the promoting command", async () => {
		// The body used to print `fixCommandFor`'s plain form
		// (`npm install … <pkg>@<version>`), which is exactly the PROMOTION the
		// paragraph above it says was avoided. A reviewer re-running it would add
		// the package to `dependencies` and reproduce a different diff.
		const body = buildVulnPrBody({ ...plan, packageName: "brace-expansion" }, { overrides: true })
		expect(body).toContain("Pinned with `overrides`")
		const rerun = body.slice(body.indexOf("Re-run locally with:"))
		expect(rerun).toContain("npm install --package-lock-only")
		expect(rerun).not.toContain("brace-expansion@")
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
	/**
	 * Successive `git status --porcelain` bodies, so a test can model "the first
	 * attempt changed nothing, the forced retry did". The last entry repeats.
	 */
	diffSequence?: string[]
	/**
	 * Serve the PRE-update lockfile even after the tool succeeded.
	 *
	 * By default the fake models a successful install by rewriting the lockfile to
	 * the patched version, because that is what the real tool does — and the
	 * post-update verification refuses a PR that leaves a vulnerable copy. A test
	 * that wants to see that refusal turns this on.
	 */
	keepVulnerableLock?: boolean
	/**
	 * Serve a lockfile that the tool DESTROYED — the package count collapses.
	 *
	 * The fake models the real npm behaviour measured on MythEclipse/web1#24: a
	 * comma-separated override selector is silently treated as matching nothing, so
	 * `npm install --package-lock-only` exits 0 having rewritten a 421-package
	 * lockfile as a 140-byte stub.
	 */
	emptiedLock?: boolean
	/** The `packageManager` field the default `package.json` reports. */
	packageManager?: string
	/** The remote head a `git/ref/heads/<branch>` read reports, when any. */
	branchHead?: string
	/** Answer the existing-PR lookup with a row that carries no numeric number. */
	malformedExistingPr?: boolean
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
				if (opts.malformedExistingPr) return { status: 200, data: [{ title: "no number" }] }
				const n = opts.existingPrFor?.(path) ?? opts.existingPr
				return { status: 200, data: n ? [{ number: n }] : [] }
			}
			if (method === "POST" && path.endsWith("/pulls")) {
				return { status: opts.prStatus ?? 201, data: { number: 77 } }
			}
			if (path.includes("/git/ref/heads/")) {
				return opts.branchHead
					? { status: 200, data: { object: { sha: opts.branchHead } } }
					: { status: 404, data: {} }
			}
			// GET /repos/{repo}
			return { status: 200, data: { default_branch: opts.defaultBranch ?? "main" } }
		},
	}
	const run = (args: string[]): GitResult => {
		gitCalls.push(args)
		if (args[0] === "clone" || args[0] === "config") return { code: 0, stdout: "", stderr: "" }
		if (args[0] === "status") {
			const seq = opts.diffSequence
			if (seq?.length) {
				const next = seq.length > 1 ? (seq.shift() as string) : (seq[0] as string)
				return { code: 0, stdout: next, stderr: "" }
			}
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
	// A successful exec means the ecosystem's own tool rewrote the lockfile. The
	// fake models that, because the post-update verification reads the lockfile
	// back and refuses to open a PR that still resolves a vulnerable copy.
	let execRan = false
	const patchedLock = (path: string): string | null => {
		const first = opts.alerts?.[0]
		const name = first?.dependency?.package?.name
		const version = first?.security_vulnerability?.first_patched_version?.identifier
		if (typeof name !== "string" || typeof version !== "string") return null
		if (path.endsWith("/package-lock.json"))
			return opts.emptiedLock
				? JSON.stringify({ packages: {} })
				: JSON.stringify({ packages: { [`node_modules/${name}`]: { version } } })
		if (path.endsWith("/pnpm-lock.yaml"))
			return `lockfileVersion: '9.0'\nsnapshots:\n  ${name}@${version}:\n`
		if (path.endsWith("/Cargo.lock"))
			return `[[package]]\nname = "${name}"\nversion = "${version}"\n`
		if (path.endsWith("/composer.lock")) return JSON.stringify({ packages: [{ name, version }] })
		return null
	}
	const exec = (args: string[]): GitResult => {
		execCalls.push(args)
		const queued = opts.execResults
		const result = queued?.length
			? queued.length > 1
				? (queued.shift() as GitResult)
				: (queued[0] as GitResult)
			: { code: 0, stdout: "", stderr: "" }
		if (result.code === 0 && !opts.keepVulnerableLock) execRan = true
		return result
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
				// After a successful update the lockfile is whatever the tool wrote.
				if (execRan) {
					const rewritten = patchedLock(p)
					if (rewritten !== null) return rewritten
				}
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
	// The fake filesystem itself, so a test can assert on what a flow WROTE
	// without hard-coding the workdir name (it carries a manifest hash).
	return { deps, requests, gitCalls, execCalls, lines, files: workdirs }
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
		expect(h.gitCalls.some((c) => c[0] === "push")).toBe(false)
		expect(h.requests.some((r) => r.method === "POST")).toBe(false)
		// The forced retry also changed nothing, and the lockfile the fake serves
		// resolves lodash at the patched version — so there is nothing vulnerable
		// left and the advisory is stale. Still no PR; the reason is just named
		// honestly instead of being handed to a person.
		expect(summary.alreadyPatched).toBe(1)
		expect(summary.manual).toBe(0)
	})

	it("a branch left by a failed PR create is replaced under a lease, not wedged", async () => {
		// A previous run can push the branch and then fail to open the PR. The next
		// run re-clones the DEFAULT branch and pushes to a branch that now exists
		// with a different commit — a non-fast-forward, rejected on every later run,
		// so the plan is wedged forever with nothing in the report to say why.
		// A force-with-lease on the branch this flow owns replaces it; the lease
		// means a human's push on top is never discarded.
		const prior = "e".repeat(40)
		const h = harness({ alerts: [alert({ number: 1 })], branchHead: prior })
		await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		const push = h.gitCalls.find((c) => c[0] === "push")
		expect(push?.join(" ")).toContain(
			`--force-with-lease=refs/heads/fix/vuln-lodash-4.17.21:${prior}`,
		)
	})

	it("a ROOT manifest is not 'fixed' by a change to a NESTED one", async () => {
		// `status.stdout.includes(manifestPath)` matched a nested path, so a plan for
		// the root `package-lock.json` "found" its change in
		// `apps/web/package-lock.json` and opened a PR claiming the root was fixed
		// when it had not moved — the silent half-fix the grouping rule forbids.
		const h = harness({
			alerts: [alert({ number: 1 })],
			// Only the nested lockfile moved.
			diff: " M apps/web/package-lock.json\n",
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		// Still NO PR — the exact-path check is what stops the half-fix — and the
		// classification is now honest about why: the root lockfile the fake serves
		// resolves lodash at the patched version, so nothing vulnerable is left
		// there and the advisory is stale rather than awaiting a person.
		expect(summary.opened).toBe(0)
		expect(summary.alreadyPatched).toBe(1)
		expect(h.gitCalls.some((c) => c[0] === "push")).toBe(false)
	})

	it("an unreadable existing-PR lookup does NOT report the fix as done", async () => {
		// `openPrForBranch` used to fold "the answer could not be read" into `-1`,
		// and the caller treated any non-zero as "already open". A malformed reply
		// therefore printed `already open as PR #-1` and counted the plan as
		// DONE — a fix never attempted, reported as one that was.
		const h = harness({
			alerts: [alert({ number: 1 })],
			malformedExistingPr: true,
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(0)
		expect(summary.failed).toBe(1)
		expect(h.lines.join("\n")).not.toContain("PR #-1")
		expect(h.gitCalls.some((c) => c[0] === "clone")).toBe(false)
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

		// THE FIX IS NOW A SCOPED FORCE, NOT A REFUSAL. An unscoped override would
		// pin the direct copy down to 0.33.0 — the same downgrade by another route —
		// but `axios@< 0.33.0` only touches the copies whose declaring range can
		// still resolve a vulnerable version, so the app's own `^1.21.1` survives.
		expect(summary.opened).toBe(1)
		expect(summary.manual).toBe(0)

		const manifest = JSON.parse(
			h.deps.workdirs.readFile("/tmp/pr-queue-work/_vuln_o_r_axios-0.33.0/package.json"),
		) as { dependencies?: Record<string, string>; overrides?: Record<string, string> }
		// The declared range is UNTOUCHED — that is the whole point.
		expect(manifest.dependencies?.axios).toBe("^1.21.1")
		expect(manifest.overrides).toEqual({ "axios@< 0.33.0": "0.33.0" })

		// And the command names no package: naming one is what rewrites the range.
		expect(h.execCalls[0]).toEqual([
			"npm",
			"install",
			"--package-lock-only",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
		])
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

		// No PR and no push: the branch would claim a remediation it does not carry.
		expect(summary.opened).toBe(0)
		expect(h.gitCalls.some((c) => c[0] === "push")).toBe(false)
		// And it is NOT a human decision any more. The lockfile the fake serves has
		// no `brace-expansion` entry at all, so there is nothing vulnerable left to
		// fix — the advisory is stale. That is a closed question, and it is reported
		// as one instead of being queued for a person who cannot action it either.
		expect(summary.alreadyPatched).toBe(1)
		expect(summary.manual).toBe(0)
		expect(h.lines.join("\n")).toContain("advisory stale")
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

	it("a plain update that resolves nothing is FORCED, not left for a human", async () => {
		// MEASURED on GMW's `esbuild` (and TeleUploader's, and zeavis-edu's): pnpm
		// exits 0 having changed nothing, because the manifest does not name the
		// package and a parent's range pins the copy it keeps. There is nothing for
		// the command to move — the override is the answer, and this used to stop
		// with "needs a human" and leave the advisory open forever.
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "npm", name: "esbuild" },
						manifest_path: "pnpm-lock.yaml",
						relationship: "transitive",
					},
					security_vulnerability: {
						package: { ecosystem: "npm", name: "esbuild" },
						severity: "medium",
						vulnerable_version_range: "<0.25.0",
						first_patched_version: { identifier: "0.25.0" },
					},
				}),
			],
			// First status: nothing moved. Second: the forced install did move the
			// lockfile.
			diffSequence: ["", " M pnpm-lock.yaml\n"],
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(1)
		expect(summary.manual).toBe(0)
		// Attempt 1 names the package (pnpm refuses or ignores it), attempt 2 is the
		// override-driven install with no package argument.
		expect(h.execCalls[0]).toEqual([
			"pnpm",
			"update",
			"esbuild@0.25.0",
			"--lockfile-only",
			"--ignore-scripts",
		])
		expect(h.execCalls[1]).toEqual(["pnpm", "install", "--lockfile-only", "--ignore-scripts"])
		const workspace = [...h.files.keys()].find((k) => k.endsWith("/pnpm-workspace.yaml"))
		expect(workspace, "no pnpm-workspace.yaml was written").toBeDefined()
		expect(h.files.get(workspace as string)).toBe("overrides:\n  esbuild: 0.25.0\n")
	})

	it("does NOT open a PR when the package manager EMPTIED the lockfile", async () => {
		// MEASURED on MythEclipse/web1#24, and it reached a user's repo: a
		// comma-separated override selector made `npm install --package-lock-only`
		// rewrite a 421-package lockfile as a 140-byte stub, exit 0, "up to date".
		// The gate that reads "resolves no copy of this package" called that
		// `alreadyPatched` — a stale advisory — so a PR was opened, merged, and the
		// user's entire dependency tree was gone.
		const plan: VulnFixPlan = {
			repo: "o/r",
			ecosystem: "npm",
			manifestPath: "package-lock.json",
			directory: "/",
			packageName: "minimatch",
			patchedVersion: "11.0.1",
			severity: "high",
			alertNumbers: [87],
			ghsaIds: ["GHSA-aaaa-bbbb-cccc"],
			transitive: true,
			vulnerableRange: ">= 7.0.0, < 11.0.1",
		}
		const workdir = `/tmp/pr-queue-work/_vuln_o_r_${vulnBranchName(plan).replace("fix/vuln-", "")}`
		const h = harness({
			alerts: [
				alert({
					number: 87,
					dependency: {
						package: { ecosystem: "npm", name: "minimatch" },
						manifest_path: "package-lock.json",
						relationship: "transitive",
					},
					security_vulnerability: {
						package: { ecosystem: "npm", name: "minimatch" },
						severity: "high",
						vulnerable_version_range: ">= 7.0.0, < 11.0.1",
						first_patched_version: { identifier: "11.0.1" },
					},
				}),
			],
			// The clone starts with a HEALTHY lockfile: three packages, the vulnerable
			// copy named at its installed version. That version has to be readable or
			// the direct-dependency guard answers first — a different (and correct)
			// refusal, which would make this test prove nothing about destruction.
			files: {
				[`${workdir}/package-lock.json`]: JSON.stringify({
					packages: {
						"": {},
						"node_modules/minimatch": { version: "10.2.6" },
						"node_modules/a": {},
					},
				}),
				[`${workdir}/package.json`]: JSON.stringify({
					name: "web1",
					dependencies: { minimatch: "^11.0.1" },
				}),
			},
			// ...and the tool replaces it with an empty one, which is what npm did.
			emptiedLock: true,
			diff: " M package-lock.json\n",
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(0)
		expect(summary.alreadyPatched).toBe(0)
		expect(h.gitCalls.some((c) => c[0] === "push")).toBe(false)
		expect(h.lines.join("\n")).toContain("SHRANK")
	})

	it("does NOT open a PR when the update leaves a vulnerable copy behind", async () => {
		// MEASURED on zeavis-edu: `cargo update -p gtk` (the escalation for
		// "glib is pinned by gtk") moves the lockfile and leaves glib at 0.18.5,
		// because gtk 0.18 pins the whole 0.18 line. A PR for that would attach a
		// "fix" to an advisory it does not fix.
		const plan: VulnFixPlan = {
			repo: "o/r",
			ecosystem: "rust",
			manifestPath: "Cargo.lock",
			directory: "/",
			packageName: "glib",
			patchedVersion: "0.20.0",
			severity: "high",
			alertNumbers: [1],
			ghsaIds: ["GHSA-aaaa-bbbb-cccc"],
			transitive: true,
			vulnerableRange: "<0.20.0",
		}
		const workdir = `/tmp/pr-queue-work/_vuln_o_r_${vulnBranchName(plan).replace("fix/vuln-", "")}`
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "rust", name: "glib" },
						manifest_path: "Cargo.lock",
					},
					security_vulnerability: {
						package: { ecosystem: "rust", name: "glib" },
						severity: "high",
						vulnerable_version_range: "<0.20.0",
						first_patched_version: { identifier: "0.20.0" },
					},
				}),
			],
			// The tool ran and rewrote the lockfile — with glib still on 0.18.5.
			keepVulnerableLock: true,
			files: {
				[`${workdir}/Cargo.lock`]: '[[package]]\nname = "glib"\nversion = "0.18.5"\n',
			},
			diff: " M Cargo.lock\n",
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(0)
		expect(h.gitCalls.some((c) => c[0] === "push")).toBe(false)
		expect(h.lines.join("\n")).toContain("still resolves 0.18.5")
	})

	it("a lockfile that resolves nothing vulnerable is STALE, not manual", async () => {
		// The other half of "resolved nothing": the repo is already fixed and
		// GitHub's alert is behind. Nobody can action that, so it must not be
		// reported as a decision someone has to make.
		const plan: VulnFixPlan = {
			repo: "o/r",
			ecosystem: "npm",
			manifestPath: "pnpm-lock.yaml",
			directory: "/",
			packageName: "minimatch",
			patchedVersion: "11.0.1",
			severity: "high",
			alertNumbers: [1],
			ghsaIds: ["GHSA-aaaa-bbbb-cccc"],
			transitive: true,
			vulnerableRange: "<11.0.1",
		}
		const workdir = `/tmp/pr-queue-work/_vuln_o_r_${vulnBranchName(plan).replace("fix/vuln-", "")}`
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "npm", name: "minimatch" },
						manifest_path: "pnpm-lock.yaml",
						relationship: "transitive",
					},
					security_vulnerability: {
						package: { ecosystem: "npm", name: "minimatch" },
						severity: "high",
						vulnerable_version_range: "<11.0.1",
						first_patched_version: { identifier: "11.0.1" },
					},
				}),
			],
			files: {
				[`${workdir}/pnpm-lock.yaml`]: [
					"lockfileVersion: '9.0'",
					"snapshots:",
					"  minimatch@11.0.1:",
					"    resolution: {integrity: sha512-x}",
					"",
				].join("\n"),
			},
			// Nothing ever moves, before or after the force.
			diffSequence: [""],
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(0)
		expect(summary.manual).toBe(0)
		expect(summary.alreadyPatched).toBe(1)
		expect(summary.failed).toBe(0)
		expect(h.lines.join("\n")).toContain("advisory stale")
		expect(h.gitCalls.some((c) => c[0] === "push")).toBe(false)
	})

	it("a pnpm transitive dependency is FORCED through pnpm.overrides", async () => {
		// MEASURED on Pemrograman-web-1's `minimatch`: pnpm refuses to pin a
		// version for an indirect dependency
		// (`ERR_PNPM_UPDATE_VERSION_ON_INDIRECT_DEP`). Its own answer is
		// `pnpm.overrides`, which is a package.json entry committed with the branch
		// — so CI's `--frozen-lockfile` accepts the resulting lockfile. This used to
		// stop as "a human's call", which left the advisory open forever.
		const h = harness({
			alerts: [
				alert({
					number: 1,
					dependency: {
						package: { ecosystem: "npm", name: "minimatch" },
						manifest_path: "pnpm-lock.yaml",
						relationship: "transitive",
					},
					security_vulnerability: {
						package: { ecosystem: "npm", name: "minimatch" },
						severity: "high",
						vulnerable_version_range: "<11.0.1",
						first_patched_version: { identifier: "11.0.1" },
					},
				}),
			],
			execResults: [
				{
					code: 1,
					stdout: "",
					stderr:
						'ERR_PNPM_UPDATE_VERSION_ON_INDIRECT_DEP  "minimatch" (requested "11.0.1") is not a direct dependency',
				},
				{ code: 0, stdout: "", stderr: "" },
			],
			diff: " M pnpm-lock.yaml\n",
		})
		const summary = await runVulnAutofix(h.deps, { token: "tok", repos: ["o/r"] })

		expect(summary.opened).toBe(1)
		expect(summary.manual).toBe(0)
		expect(summary.failed).toBe(0)

		// The entry pnpm 12 actually reads: `overrides` in pnpm-workspace.yaml.
		const workspace = [...h.files.keys()].find((k) => k.endsWith("/pnpm-workspace.yaml"))
		expect(workspace, "no pnpm-workspace.yaml was written").toBeDefined()
		expect(h.files.get(workspace as string)).toBe("overrides:\n  minimatch: 11.0.1\n")

		// The retry is a lockfile-only install with NO package argument: naming the
		// package is the thing pnpm refuses.
		expect(h.execCalls[1]).toEqual(["pnpm", "install", "--lockfile-only", "--ignore-scripts"])
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

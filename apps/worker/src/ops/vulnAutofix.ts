/**
 * Dependabot security remediation, ACTUALLY FIXING SOMETHING.
 *
 * WHAT WAS HERE BEFORE. `--fix-vulns` derived Dependabot `updates:` lanes from
 * each repo's open alerts and wrote the config that carries them. That is
 * necessary — an alert on a manifest no lane names can never become a PR — but
 * it is not a fix, and the fleet proves it: measured on 2026-11-16, 52 owned
 * repos carried **129 open alerts, 126 of them with a published patched
 * version**, every affected repo had `automated-security-fixes` enabled and
 * `paused: false`, the lanes existed, and there were **zero open Dependabot PRs**
 * anywhere. Nothing was being fixed. The config was in place; the remediation
 * was not. `VulnFixResult` was declared and never constructed, which is the
 * honest signature of a feature that only ever wrote configuration.
 *
 * WHAT THIS DOES INSTEAD. For each fixable alert it does the bump itself, on a
 * branch, and opens the PR:
 *
 *   1. group the repo's alerts into one unit of work per (manifest, package),
 *   2. clone the default branch,
 *   3. run the ECOSYSTEM'S OWN update command against the lockfile the alert
 *      names (`npm install --package-lock-only`, `pnpm update --lockfile-only`,
 *      `cargo update --precise`, `composer update`, `bundle update`, …),
 *   4. refuse to open a PR if the command changed nothing — a "fix" that
 *      produces no diff is a claim, not a fix,
 *   5. commit, push, and open a PR that names the advisories and links the
 *      repo's Dependabot page.
 *
 * WHY THE WORKER BUMPS RATHER THAN WAITING FOR DEPENDABOT. Waiting is what the
 * fleet did for weeks: `automated-security-fixes` was on and produced nothing.
 * The worker already owns the whole downstream pipeline for a PR it opens (review
 * → CI gate → merge), so opening the PR itself closes the loop with machinery
 * that exists and is tested. Dependabot's own security PRs are still welcome —
 * this does not disable them, and it skips a package that already has an open
 * PR for the same branch.
 *
 * WHY ONE PR PER (MANIFEST, PACKAGE) AND NOT ONE PER REPO. A single PR that
 * bumps 88 packages (BotWa's count) cannot be reviewed, cannot be bisected when
 * CI goes red, and would be closed rather than merged. One package per PR is
 * what a human would do, and it is what the merge gate can judge.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: ecosystems whose update cannot be expressed
 * as one lockfile command (maven, gradle, pip without a lock, docker, actions)
 * are reported as MANUAL rather than attempted. A half-applied bump is worse
 * than a listed one, and Dependabot's own lanes still cover those.
 */

import type { GitRunner } from "../git.ts"
import { pushRef } from "../git.ts"
import {
	clonePr,
	head,
	type ProcRunner,
	reportable,
	TMP_BASE,
	type Workdirs,
} from "../pr/lockfix.ts"
import type { GhClient } from "../pr/scan.ts"
import { type DependabotAlert, fetchOpenDependabotAlertsResult } from "./security.ts"

/** One unit of work: a single package, on a single manifest, in one repo. */
export type VulnFixPlan = {
	repo: string
	/** Dependabot config ecosystem (`npm`, `cargo`, `composer`, …). */
	ecosystem: string
	/** The file the alert names — usually the LOCKFILE, e.g. `pnpm-lock.yaml`. */
	manifestPath: string
	/** Directory to run the update in, `/` for the repo root. */
	directory: string
	packageName: string
	/** The version to move to. Highest patched version across the group. */
	patchedVersion: string
	/** Worst severity in the group, for the PR body. */
	severity: string
	alertNumbers: number[]
	ghsaIds: string[]
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }

const worse = (a: string, b: string): string =>
	(SEVERITY_RANK[b.toLowerCase()] ?? 0) > (SEVERITY_RANK[a.toLowerCase()] ?? 0) ? b : a

/**
 * Compare two dotted versions well enough to pick the highest patch.
 *
 * Not a full semver implementation: it compares numeric segments, treats a
 * prerelease as LOWER than the release (`1.2.3-rc.1` < `1.2.3`), and falls back
 * to string order for anything it cannot parse. That is all "which of these
 * patched versions is newest" needs, and pulling a semver library in for it
 * would be a dependency for one comparison.
 */
export function compareVersions(a: string, b: string): number {
	const split = (v: string): { nums: number[]; pre: string } => {
		const [core, ...rest] = v.replace(/^v/, "").split("-")
		const nums = (core ?? "")
			.split(".")
			.map((p) => Number.parseInt(p, 10))
			.map((n) => (Number.isFinite(n) ? n : 0))
		return { nums, pre: rest.join("-") }
	}
	const A = split(a)
	const B = split(b)
	const len = Math.max(A.nums.length, B.nums.length)
	for (let i = 0; i < len; i += 1) {
		const x = A.nums[i] ?? 0
		const y = B.nums[i] ?? 0
		if (x !== y) return x < y ? -1 : 1
	}
	if (A.pre === B.pre) return 0
	if (!A.pre) return 1
	if (!B.pre) return -1
	return A.pre < B.pre ? -1 : 1
}

/** Directory of a manifest path, in the form the update command needs. */
export function directoryOf(manifestPath: string): string {
	const trimmed = manifestPath.replace(/^\/+/, "")
	const i = trimmed.lastIndexOf("/")
	return i === -1 ? "/" : `/${trimmed.slice(0, i)}`
}

/**
 * Group a repo's open alerts into one plan per (manifest, package).
 *
 * THE GROUPING KEY IS THE MANIFEST, NOT THE ECOSYSTEM. Two `requirements.txt`
 * files in different directories are two different updates, and one command
 * cannot serve both — running the bump in the repo root would update whichever
 * lockfile the tool finds there and leave the other one vulnerable, which is
 * exactly the silent half-fix this module must not produce.
 *
 * Alerts with no `first_patched_version` are dropped: there is nothing to
 * upgrade to. They are not forgotten — the alert stays open and a later run
 * picks it up the moment upstream publishes a fix.
 */
export function planVulnFixes(repo: string, alerts: readonly DependabotAlert[]): VulnFixPlan[] {
	const byKey = new Map<string, VulnFixPlan>()
	for (const alert of alerts) {
		const patched = alert.security_vulnerability?.first_patched_version?.identifier
		if (typeof patched !== "string" || patched.trim() === "") continue
		const pkg = alert.dependency?.package?.name
		const manifestPath = alert.dependency?.manifest_path
		if (typeof pkg !== "string" || pkg === "" || typeof manifestPath !== "string") continue
		const ecosystem = alert.dependency?.package?.ecosystem ?? ""
		const key = `${manifestPath}\u0000${pkg}`
		const existing = byKey.get(key)
		if (!existing) {
			byKey.set(key, {
				repo,
				ecosystem,
				manifestPath,
				directory: directoryOf(manifestPath),
				packageName: pkg,
				patchedVersion: patched,
				severity: alert.security_vulnerability?.severity ?? alert.security_advisory?.severity ?? "",
				alertNumbers: [alert.number],
				ghsaIds: alert.security_advisory?.ghsa_id ? [alert.security_advisory.ghsa_id] : [],
			})
			continue
		}
		// Several advisories can sit on one package. Take the HIGHEST patch (the
		// lower one would leave the other advisory open) and keep every advisory
		// id, because the PR body is what a reviewer uses to check the fix.
		if (compareVersions(patched, existing.patchedVersion) > 0) existing.patchedVersion = patched
		existing.severity = worse(existing.severity, alert.security_vulnerability?.severity ?? "")
		if (!existing.alertNumbers.includes(alert.number)) existing.alertNumbers.push(alert.number)
		const ghsa = alert.security_advisory?.ghsa_id
		if (ghsa && !existing.ghsaIds.includes(ghsa)) existing.ghsaIds.push(ghsa)
	}
	return [...byKey.values()].sort(
		(a, b) =>
			a.manifestPath.localeCompare(b.manifestPath) || a.packageName.localeCompare(b.packageName),
	)
}

/** The update command for a plan, or the reason it needs a human. */
export type FixCommand =
	| {
			argv: string[]
			/**
			 * A second form to try when the first is refused for a reason the flag
			 * can fix — today only npm's `ERESOLVE`.
			 *
			 * MEASURED: BotWa's `axios` bump dies with `ERESOLVE could not resolve
			 * … baileys@6.17.16 … jimp@1.6.1` — a peer conflict between two
			 * packages that have nothing to do with the advisory. That is the repo's
			 * pre-existing state, not something this bump created, and without the
			 * flag 88 fixable alerts on that repo stay unfixable. `--legacy-peer-deps`
			 * is npm's own documented escape hatch for exactly that.
			 *
			 * WHY THIS IS SAFE TO TRY: the resulting lockfile still has to install in
			 * CI (`npm ci`) before the PR can merge. A lockfile that only resolves
			 * with the flag turns CI red and the PR never lands, which is the correct
			 * outcome — the alternative (no PR at all) hides the advisory forever.
			 */
			fallback?: string[]
	  }
	| { manual: string }

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1)

/**
 * The ecosystem's own "move this dependency to that version" command.
 *
 * LOCKFILE-ONLY WHERE THE TOOL SUPPORTS IT. `npm install --package-lock-only`
 * and `pnpm update --lockfile-only` rewrite the lockfile and leave
 * `node_modules` alone, which is what a CI-bound branch wants: a full install
 * on the worker would take minutes per repo and change nothing that gets
 * committed. `cargo update --precise` and `composer update` are already
 * lockfile-scoped.
 *
 * `yarn` NEEDS TWO FORMS. Yarn 1 has no `up`; Berry has no `upgrade`. The repo
 * declares which one it is in `package.json`'s `packageManager` field, and the
 * caller passes that in rather than this function guessing — guessing wrong
 * runs a command that exits 0 without touching the lockfile, which the diff
 * check would then report as "nothing to fix".
 */
export function fixCommandFor(plan: VulnFixPlan, opts: { yarnBerry?: boolean } = {}): FixCommand {
	const file = basename(plan.manifestPath).toLowerCase()
	const pkg = plan.packageName
	const ver = plan.patchedVersion
	switch (file) {
		case "package-lock.json":
		case "npm-shrinkwrap.json": {
			const argv = [
				"npm",
				"install",
				"--package-lock-only",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				`${pkg}@${ver}`,
			]
			return { argv, fallback: [...argv, "--legacy-peer-deps"] }
		}
		case "pnpm-lock.yaml":
			return { argv: ["pnpm", "update", `${pkg}@${ver}`, "--lockfile-only", "--ignore-scripts"] }
		case "yarn.lock":
			return {
				argv: opts.yarnBerry
					? ["yarn", "up", `${pkg}@${ver}`]
					: ["yarn", "upgrade", `${pkg}@${ver}`],
			}
		case "composer.lock":
			return {
				argv: [
					"composer",
					"update",
					pkg,
					"--with-dependencies",
					"--no-interaction",
					"--no-scripts",
				],
			}
		case "cargo.lock":
			return { argv: ["cargo", "update", "-p", pkg, "--precise", ver] }
		case "gemfile.lock":
			return { argv: ["bundle", "update", pkg, "--conservative"] }
		case "go.sum":
		case "go.mod":
			return { argv: ["go", "get", `${pkg}@${ver}`] }
		default:
			return {
				manual: `no single-command update for ${file} (${plan.ecosystem}) — Dependabot's own lane covers it`,
			}
	}
}

/** A branch name GitHub will accept: no `@`, no `/` from a scoped package. */
export function vulnBranchName(plan: VulnFixPlan): string {
	const slug = `${plan.packageName}-${plan.patchedVersion}`
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 60)
	return `fix/vuln-${slug || "dependency"}`
}

/** `https://github.com/<repo>/security/dependabot/<n>` — the page a human opens. */
export function alertUrl(repo: string, number: number): string {
	return `https://github.com/${repo}/security/dependabot/${number}`
}

/** The Dependabot page for a repo, as the user names it. */
export function dependabotUrl(repo: string): string {
	return `https://github.com/${repo}/security/dependabot`
}

/**
 * The PR body.
 *
 * IT LINKS THE ALERTS, not just the package name. The reviewer's first question
 * is "which advisory is this about, and does the new version actually clear it"
 * — the answer is one click away on the Dependabot page, and a body that only
 * says "bump x" moves that lookup onto the reviewer.
 */
export function buildVulnPrBody(
	plan: VulnFixPlan,
	opts: { legacyPeerDeps?: boolean } = {},
): string {
	const advisories = plan.ghsaIds.length ? plan.ghsaIds.join(", ") : "security advisory"
	const links = plan.alertNumbers
		.map((n) => `- [alert #${n}](${alertUrl(plan.repo, n)})`)
		.join("\n")
	const command = fixCommandFor(plan)
	const commandLine = "argv" in command ? command.argv.join(" ") : "(no automatic command)"
	return (
		`Bumps \`${plan.packageName}\` to **${plan.patchedVersion}** in \`${plan.manifestPath}\` ` +
		`to clear ${advisories} (${plan.severity || "unknown"} severity).\n\n` +
		`${links}\n\n` +
		`All alerts on this page: ${dependabotUrl(plan.repo)}\n\n` +
		`Opened by pr-queue-worker: \`automated-security-fixes\` was enabled on this repo and ` +
		`the advisory had a published patched version, but no PR had been opened for it, so the ` +
		`worker applied the update itself. The lockfile is the only file this PR should touch; ` +
		`CI and the normal review gate decide whether it merges.\n\n` +
		(opts.legacyPeerDeps
			? `\n**Resolved with \`--legacy-peer-deps\`.** npm refused the bump with ` +
				`\`ERESOLVE\` — a peer conflict this repo already had, between packages ` +
				`unrelated to the advisory. The flag is npm's documented escape hatch; CI ` +
				`still has to install this lockfile before the PR can merge, so a resolution ` +
				`that does not really work fails there rather than here.\n`
			: "") +
		`Re-run locally with:\n\n\`\`\`\ncd ${plan.directory === "/" ? "." : plan.directory}\n` +
		`${opts.legacyPeerDeps ? `${commandLine} --legacy-peer-deps` : commandLine}\n\`\`\``
	)
}

/** One repo's outcome, kept so the CLI can print the page a human should open. */
export type RepoAutofixResult = {
	repo: string
	/** Open alerts seen, fixable or not. */
	openAlerts: number
	/** Alerts that had a patched version, i.e. work this run could do. */
	fixable: number
	opened: number
	/** True when the repo could not be read at all. */
	unreadable: boolean
}

/** What one run did, per repo and in total. */
export type VulnAutofixSummary = {
	opened: number
	skipped: number
	manual: number
	failed: number
	lines: string[]
	perRepo: RepoAutofixResult[]
}

export type VulnAutofixDeps = {
	api: GhClient
	run: GitRunner
	exec: ProcRunner
	workdirs: Workdirs
	fetchGhToken: () => string
	/** Preview only: report the plan and write nothing. */
	dry: boolean
	report: (line: string) => void
}

export type VulnAutofixOpts = {
	token: string
	/** `owner/repo` names to work on. */
	repos: readonly string[]
	/**
	 * Cap per repo. One PR per package can be a lot for a repo like BotWa (88
	 * fixable alerts); the cap keeps a single run from opening hundreds of PRs
	 * at once, and the next run continues where this one stopped because a
	 * package with an open PR is skipped.
	 */
	maxPrsPerRepo?: number
}

const CLONE_DEPTH = 20
const UPDATE_TIMEOUT_SEC = 900

/**
 * Is there already an open PR for this branch? Then this run has nothing to do.
 *
 * A repo-wide "is there any open vuln PR" check would be wrong: it would let one
 * open PR suppress every other package in the repo. The check is per branch.
 */
async function openPrForBranch(
	api: GhClient,
	repo: string,
	branch: string,
	token: string,
): Promise<number> {
	const owner = repo.split("/")[0] ?? ""
	const { status, data } = await api.request(
		"GET",
		`/repos/${repo}/pulls?state=open&head=${owner}:${branch}&per_page=1`,
		{ token },
	)
	if (status !== 200 || !Array.isArray(data) || data.length === 0) return 0
	const n = Number((data[0] as { number?: number })?.number)
	return Number.isFinite(n) ? n : -1
}

/**
 * One plan, end to end: clone, update, commit, push, open the PR.
 *
 * RETURNS A RESULT RATHER THAN THROWING, like every other flow here: a repo that
 * fails must not stop the other 51, and the caller has to be able to say WHICH
 * repo failed and why.
 */
async function applyPlan(
	deps: VulnAutofixDeps,
	plan: VulnFixPlan,
	opts: { token: string; defaultBranch: string },
): Promise<{ ok: boolean; prUrl?: string; detail: string; manual?: boolean }> {
	const { run, exec, workdirs, api } = deps
	const branch = vulnBranchName(plan)
	// `_vuln_` INFIX: the lockfix/autofix clones under TMP_BASE are swept by
	// `sweepStale` against the open-PR set, and a directory that does not match
	// that naming would either be swept as an orphan or never swept at all. This
	// flow removes its own workdir on every exit path, so the infix keeps the two
	// families apart instead of relying on the sweep to guess.
	const slug = `${plan.packageName}-${plan.patchedVersion}`
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.slice(0, 60)
	const workdir = `${TMP_BASE}/_vuln_${plan.repo.replace(/\//g, "_")}_${slug}`

	const existing = await openPrForBranch(api, plan.repo, branch, opts.token)
	if (existing !== 0) return { ok: true, detail: `already open as PR #${existing}` }

	workdirs.remove(workdir)
	workdirs.mkdir(workdir)
	const cloned = clonePr(run, plan.repo, opts.defaultBranch, opts.token, workdir, CLONE_DEPTH)
	if (cloned.code !== 0) {
		workdirs.remove(workdir)
		return { ok: false, detail: `clone failed: ${head(reportable(cloned.stderr), 200)}` }
	}

	const command = fixCommandFor(plan)
	if (!("argv" in command)) {
		workdirs.remove(workdir)
		return { ok: false, detail: command.manual }
	}
	const cwd = plan.directory === "/" ? workdir : `${workdir}${plan.directory}`
	const [program, ...args] = command.argv
	let updated = exec([program ?? "", ...args], cwd, UPDATE_TIMEOUT_SEC)
	let usedFallback = false
	if (updated.code !== 0) {
		const why = `${updated.stderr}${updated.stdout}`
		// 124 is `runProc`'s timeout sentinel (index.ts), not an exit code any of
		// these tools use. A big workspace can legitimately spend minutes
		// resolving, so this is a budget report rather than a diagnosis.
		if (updated.code === 124) {
			workdirs.remove(workdir)
			return {
				ok: false,
				detail: `${program} timed out after ${UPDATE_TIMEOUT_SEC}s — left for the next run`,
			}
		}
		// 127 IS NOT A LOCKFILE PROBLEM. It means the ecosystem's tool is not
		// installed on the host running the worker — `composer`, `cargo`, `bundle`.
		// Saying "composer exited 127" sends the reader to the repo when the fix is
		// an install on the worker box, so it is named as what it is.
		if (updated.code === 127 || /ENOENT/.test(why)) {
			workdirs.remove(workdir)
			return {
				ok: false,
				detail: `${program} is not installed on this host — the ${plan.ecosystem} fix needs that tool`,
			}
		}
		// PNPM WILL NOT PIN A TRANSITIVE DEPENDENCY, and says so:
		// `ERR_PNPM_UPDATE_VERSION_ON_INDIRECT_DEP — "<pkg>" (requested "X") is not a
		// direct dependency`. Measured on Pemrograman-web-1's `minimatch`. There is
		// no lockfile-scoped way around it (`pnpm.overrides` would have to stay in
		// package.json for CI's `--frozen-lockfile` to accept the result, which
		// changes the repo's contract), so this is reported as MANUAL with the
		// reason instead of being retried into the same wall.
		if (/ERR_PNPM_UPDATE_VERSION_ON_INDIRECT_DEP/.test(why)) {
			workdirs.remove(workdir)
			return {
				ok: false,
				manual: true,
				detail: `${plan.packageName} is a TRANSITIVE dependency — pnpm will not pin a version for it (needs a pnpm.overrides entry, which is a human's call)`,
			}
		}
		// One retry, only for the peer-conflict flag. Anything else is the repo's
		// own problem and retrying it just doubles the run time.
		if (command.fallback && /ERESOLVE|peer dep/i.test(why)) {
			const [fprogram, ...fargs] = command.fallback
			updated = exec([fprogram ?? "", ...fargs], cwd, UPDATE_TIMEOUT_SEC)
			usedFallback = updated.code === 0
			if (!usedFallback) {
				workdirs.remove(workdir)
				const failWhy = reportable((updated.stderr || updated.stdout || "").trim())
				return {
					ok: false,
					detail: `${fprogram} exited ${updated.code} (with --legacy-peer-deps): ${head(failWhy, 300)}`,
				}
			}
		} else {
			workdirs.remove(workdir)
			const failWhy = reportable((updated.stderr || updated.stdout || "").trim())
			return { ok: false, detail: `${program} exited ${updated.code}: ${head(failWhy, 300)}` }
		}
	}

	// A FIX WITH NO DIFF IS NOT A FIX. The update command can exit 0 and change
	// nothing — a version range that already allows the patched release, a
	// lockfile the tool decided was up to date, a `yarn upgrade` that resolved
	// nothing. Opening a PR from that would claim a remediation the branch does
	// not contain, and the alert would stay open with a "fix" attached to it.
	const status = run(["status", "--porcelain"], workdir, 60)
	if (status.code !== 0 || status.stdout.trim() === "") {
		workdirs.remove(workdir)
		// `pnpm` exits 0 having resolved nothing when the package is transitive and
		// the parent's range already pins the version it keeps — measured on GMW's
		// `esbuild`. Naming both possibilities saves the reader a re-run.
		return {
			ok: false,
			manual: true,
			detail: `the package manager resolved nothing (${program} exited 0): already at the patched version, or pinned by a parent's range`,
		}
	}

	const message = `fix(deps): bump ${plan.packageName} to ${plan.patchedVersion} for ${plan.ghsaIds.join(", ") || "security advisory"}`
	const committed = run(["commit", "-am", message], workdir, 120)
	if (committed.code !== 0) {
		workdirs.remove(workdir)
		return { ok: false, detail: `commit failed: ${head(reportable(committed.stderr), 200)}` }
	}

	// PAT first, then the App token — the same ordering `git.ts` documents, for
	// the same reason: a branch that touches `.github/workflows/*` is refused for
	// an App without the `workflows` permission, and the PAT has it.
	const pushed = pushRef(workdir, plan.repo, "HEAD", `refs/heads/${branch}`, opts.token, false, {
		pat: deps.fetchGhToken(),
		run,
	})
	if (!pushed.ok) {
		workdirs.remove(workdir)
		return { ok: false, detail: `push failed: ${pushed.detail}` }
	}

	const created = await api.request("POST", `/repos/${plan.repo}/pulls`, {
		token: opts.token,
		json: {
			title: `fix(deps): bump ${plan.packageName} to ${plan.patchedVersion} (security)`,
			head: branch,
			base: opts.defaultBranch,
			body: buildVulnPrBody(plan, { legacyPeerDeps: usedFallback }),
		},
	})
	workdirs.remove(workdir)
	if (created.status === 200 || created.status === 201) {
		const number = Number((created.data as { number?: number })?.number)
		return {
			ok: true,
			prUrl: `https://github.com/${plan.repo}/pull/${number}`,
			detail: "PR opened",
		}
	}
	// 422 is GitHub's "a pull request already exists for this head" — the branch
	// is pushed and the PR exists, so the work IS done even though the POST failed.
	if (created.status === 422) return { ok: true, detail: "PR already exists" }
	return { ok: false, detail: `PR create failed (HTTP ${created.status})` }
}

/**
 * Run the fixer over a list of repos.
 *
 * NEVER THROWS. One repo's failure is one `⚠️` line; the rest still get fixed.
 * That matters more here than elsewhere: this runs nightly against 50+ repos and
 * a single bad lockfile must not cost the fleet its security run.
 */
export async function runVulnAutofix(
	deps: VulnAutofixDeps,
	opts: VulnAutofixOpts,
): Promise<VulnAutofixSummary> {
	const summary: VulnAutofixSummary = {
		opened: 0,
		skipped: 0,
		manual: 0,
		failed: 0,
		lines: [],
		perRepo: [],
	}
	const say = (line: string): void => {
		summary.lines.push(line)
		deps.report(line)
	}
	const maxPerRepo = opts.maxPrsPerRepo ?? 5

	for (const repo of opts.repos) {
		const alerts = await fetchOpenDependabotAlertsResult(deps.api, repo, opts.token)
		if (!alerts.ok && alerts.alerts.length === 0) {
			summary.failed += 1
			summary.perRepo.push({ repo, openAlerts: 0, fixable: 0, opened: 0, unreadable: true })
			say(`   ⚠️  ${repo}: alerts unreadable (HTTP ${alerts.status}) — nothing fixed here`)
			continue
		}
		if (!alerts.ok) {
			// A partial read is still actionable: every plan stands on its own.
			say(`   ⚠️  ${repo}: alert list partially read (HTTP ${alerts.status}) — fixing what was read`)
		}
		const plans = planVulnFixes(repo, alerts.alerts)
		const perRepo: RepoAutofixResult = {
			repo,
			openAlerts: alerts.alerts.length,
			fixable: plans.reduce((sum, p) => sum + p.alertNumbers.length, 0),
			opened: 0,
			unreadable: false,
		}
		summary.perRepo.push(perRepo)
		if (plans.length === 0) {
			summary.skipped += 1
			continue
		}
		// The default branch decides where the fix branches start. Read once per
		// repo: a wrong base would make the PR point at a branch that does not
		// exist and GitHub would answer 422 for a reason that looks like a dup.
		const meta = await deps.api.request("GET", `/repos/${repo}`, { token: opts.token })
		const defaultBranch =
			meta.status === 200 &&
			typeof (meta.data as { default_branch?: string })?.default_branch === "string"
				? ((meta.data as { default_branch: string }).default_branch ?? "main")
				: "main"

		let taken = 0
		for (const plan of plans) {
			const command = fixCommandFor(plan)
			if (!("argv" in command)) {
				summary.manual += 1
				say(
					`   ℹ️  ${repo}: ${plan.packageName} on ${plan.manifestPath} needs a human — ${command.manual}`,
				)
				continue
			}
			if (taken >= maxPerRepo) {
				summary.skipped += 1
				say(
					`   ⏭️  ${repo}: ${plans.length - taken} more fix(es) left for the next run (cap ${maxPerRepo}/repo)`,
				)
				break
			}
			taken += 1
			if (deps.dry) {
				summary.skipped += 1
				say(
					`   🧪 dry run: would bump ${plan.packageName} -> ${plan.patchedVersion} on ${plan.manifestPath} (${plan.alertNumbers.length} alert(s))`,
				)
				continue
			}
			const res = await applyPlan(deps, plan, { token: opts.token, defaultBranch })
			if (res.ok) {
				summary.opened += 1
				perRepo.opened += 1
				say(
					`   ✅ ${repo}: ${plan.packageName} -> ${plan.patchedVersion} (${plan.alertNumbers.length} alert(s)) ${res.prUrl ?? res.detail}`,
				)
			} else if (res.manual) {
				// NOT a failure: the tooling answered "a human has to decide". Counting
				// it as a failure would make a healthy nightly run look broken and
				// teach the reader to ignore the number.
				summary.manual += 1
				say(
					`   ℹ️  ${repo}: ${plan.packageName} -> ${plan.patchedVersion} needs a human — ${res.detail}`,
				)
			} else {
				summary.failed += 1
				say(`   ⚠️  ${repo}: ${plan.packageName} -> ${plan.patchedVersion} failed — ${res.detail}`)
			}
		}
	}
	return summary
}

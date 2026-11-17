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

import { createHash } from "node:crypto"
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
	/**
	 * Every alert in this group is on a TRANSITIVE dependency (not named in the
	 * manifest). It changes the update strategy for npm, which cannot pin a
	 * transitive version from the command line without promoting it — see
	 * `applyPlan`.
	 */
	transitive: boolean
	/**
	 * The advisory's own vulnerable range, e.g. `<11.0.1` or `>=4.0.0 <5.2.2`.
	 *
	 * Carried because a FORCED version sometimes has to be scoped to the copies
	 * that are actually vulnerable. An unscoped override pins every copy of the
	 * package, including the one the app imports — and when that copy is already
	 * at or above the patched version, pinning it is a DOWNGRADE. npm and pnpm
	 * both accept `"<pkg>@<range>": "<version>"` as an override key, so this range
	 * is what makes the force precise instead of blunt.
	 */
	vulnerableRange: string
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
				transitive: alert.dependency?.relationship === "transitive",
				vulnerableRange: alert.security_vulnerability?.vulnerable_version_range ?? "",
			})
			continue
		}
		// Several advisories can sit on one package. Take the HIGHEST patch (the
		// lower one would leave the other advisory open) and keep every advisory
		// id, because the PR body is what a reviewer uses to check the fix.
		if (compareVersions(patched, existing.patchedVersion) > 0) {
			existing.patchedVersion = patched
			// The range that belongs to the patch we keep: scoping a force to the
			// range of a LOWER patch would leave the other advisory reachable.
			existing.vulnerableRange = alert.security_vulnerability?.vulnerable_version_range ?? ""
		} else if (existing.vulnerableRange === "") {
			existing.vulnerableRange = alert.security_vulnerability?.vulnerable_version_range ?? ""
		}
		// A group is "transitive" only if EVERY advisory in it is: one direct
		// advisory means the manifest already names the package, and the plain
		// install is the right command.
		if (alert.dependency?.relationship !== "transitive") existing.transitive = false
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
			 * What makes the fallback worth trying. Defaults to npm's peer-conflict
			 * text, which is the only reason npm has a fallback at all; composer
			 * retries on a platform/dependent conflict instead.
			 */
			retryOn?: RegExp
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
		case "composer.lock": {
			const argv = [
				"composer",
				"update",
				pkg,
				"--with-dependencies",
				"--no-interaction",
				"--no-scripts",
			]
			// MEASURED on AETHRA-Organizer-Website and projectpweb2, in this order:
			//   1. `--with-dependencies` stops at "laravel/pint v1.32.3 requires
			//      ext-xml" — the box had no php-xml, now installed;
			//   2. then at "brianium/paratest v7.8.3 requires php ~8.2 || ~8.3 ||
			//      ~8.4 -> your php version (8.5.4) does not satisfy that
			//      requirement" — the WORKER's PHP is newer than the repo's target,
			//      which says nothing about the repo;
			//   3. then at "pestphp/pest is locked to version v3.8.2 … conflicts with
			//      phpunit/phpunit 11.5.50" — `--with-dependencies` will not move a
			//      package that merely DEPENDS on the one being bumped.
			// `-W` moves those dependents and `--ignore-platform-req=php` resolves
			// for the repo's declared PHP instead of this host's. CI is the arbiter:
			// a lockfile that does not install there turns the PR red.
			return {
				argv,
				fallback: [
					"composer",
					"update",
					pkg,
					"--with-all-dependencies",
					"--no-interaction",
					"--no-scripts",
					"--ignore-platform-req=php",
				],
				retryOn:
					/does not satisfy that requirement|requires php|conflicts with|locked to version|not satisfiable/i,
			}
		}
		case "cargo.lock":
			return { argv: ["cargo", "update", "-p", pkg, "--precise", ver] }
		case "gemfile.lock":
			return { argv: ["bundle", "update", pkg, "--conservative"] }
		case "uv.lock":
			// UV IS SUPPORTED ELSEWHERE IN THIS WORKER, so reporting it MANUAL here
			// was an inconsistency, not a policy. `pr/managers.ts` already
			// re-resolves a uv repo with `uv lock` for the lockfile pre-fix, and
			// `uv.lock` is a lockfile whose only writer is that command — it does
			// not touch the manifests. `uv lock --upgrade-package <pkg>` is the
			// targeted form: a bare `uv lock` re-resolves the whole graph and would
			// change versions nobody asked about, on a PR that is supposed to move
			// one package.
			return {
				argv: ["uv", "lock", "--upgrade-package", `${pkg}==${ver}`],
			}
		case "go.sum":
		case "go.mod":
			return { argv: ["go", "get", `${pkg}@${ver}`] }
		default:
			return {
				manual: `no single-command update for ${file} (${plan.ecosystem}) — Dependabot's own lane covers it`,
			}
	}
}

/**
 * The declared range for a package in package.json, or `null` when the package
 * is not declared at all (i.e. it is transitive).
 *
 * All four sections are checked: a `devDependency` is just as direct as a
 * `dependency`, and treating it as transitive would take the `overrides` path
 * against a package the repo names on purpose.
 */
export function npmDirectRange(manifest: Record<string, unknown>, pkg: string): string | null {
	for (const section of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		const block = manifest[section]
		if (block === null || typeof block !== "object") continue
		const range = (block as Record<string, unknown>)[pkg]
		if (typeof range === "string") return range
	}
	return null
}

/**
 * The version npm actually installed at the TOP level, from the lockfile.
 *
 * Read through `Workdirs` rather than `fs` so the flow stays testable, and
 * `null` on anything unparseable — the caller treats "cannot tell" as "do not
 * move it", which is the safe direction for a dependency that the app imports.
 */
export function npmLockedVersion(workdirs: Workdirs, lockPath: string, pkg: string): string | null {
	try {
		const lock = JSON.parse(workdirs.readFile(lockPath)) as {
			packages?: Record<string, { version?: string }>
		}
		const entry = lock.packages?.[`node_modules/${pkg}`]
		return typeof entry?.version === "string" ? entry.version : null
	} catch {
		return null
	}
}

/**
 * The install command that re-resolves a lockfile after a forced version has
 * been written into `package.json`.
 *
 * LOCKFILE-ONLY, for the same reason `fixCommandFor` uses those forms: the
 * branch only ever commits the lockfile, and a full install on the worker would
 * spend minutes populating a `node_modules` nobody keeps.
 */
function installOnlyFor(file: string): string[] {
	switch (file) {
		case "package-lock.json":
		case "npm-shrinkwrap.json":
			return [
				"npm",
				"install",
				"--package-lock-only",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
			]
		case "pnpm-lock.yaml":
			return ["pnpm", "install", "--lockfile-only", "--ignore-scripts"]
		case "yarn.lock":
			return ["yarn", "install"]
		default:
			return []
	}
}

/**
 * Write the ecosystem's own "resolve this package to that version" entry into
 * `package.json`.
 *
 * WHY THIS EXISTS AS A SHARED HELPER. The npm path has always used `overrides`
 * for a transitive dependency; pnpm's equivalent (`pnpm.overrides`) was reported
 * as "a human's call" instead, and yarn's (`resolutions`) was not attempted at
 * all. That was a policy the flow does not get to make: an open advisory with a
 * published patch is work, not a decision. The entry lives in `package.json`, so
 * it is committed with the branch and CI's `--frozen-lockfile` accepts the
 * lockfile that comes out of it.
 *
 * `scopeToRange` is the safety valve. npm and pnpm accept
 * `"<pkg>@<range>": "<version>"`, which forces only the copies whose declaring
 * range matches — so a package that is ALSO a direct dependency at a safe
 * version keeps that version instead of being dragged down to the patch.
 * Yarn's `resolutions` has no such selector, so a scoped force returns null
 * there rather than silently downgrading a direct dependency.
 *
 * THE FILE'S OWN INDENTATION IS KEPT. Re-serialising with a fixed indent
 * rewrites every line of `package.json` — measured on BotWa, whose four-space
 * file came back as tabs — and a reviewer cannot see the two lines that matter
 * through a whole-file diff.
 */
/**
 * Append (or replace) one entry under `overrides:` in a `pnpm-workspace.yaml`.
 *
 * PNPM MOVED THIS SETTING. Measured on the box's pnpm 12.16.1:
 * `[WARN] The "pnpm" field in package.json is no longer read by pnpm. The
 * following keys were ignored: "pnpm.overrides"` — the write succeeded, the
 * install exited 0, and the lockfile did not move, which is exactly the
 * "resolved nothing" wall. With the same entry under `overrides:` in
 * `pnpm-workspace.yaml` the lockfile went from minimatch 10.2.6 to 11.0.1.
 *
 * Hand-edited rather than serialised: this bundle has no YAML parser, and the
 * file is a flat settings list. An existing key is REPLACED, so a second run
 * does not stack duplicate entries.
 */
export function writeWorkspaceOverride(raw: string, key: string, version: string): string {
	const entry = `  ${/[:#@<>*&!|]/.test(key) ? `"${key}"` : key}: ${version}`
	const lines = raw === "" ? [] : raw.replace(/\s+$/, "").split("\n")
	const start = lines.findIndex((line) => /^overrides:\s*$/.test(line))
	if (start === -1) {
		return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}overrides:\n${entry}\n`
	}
	// The block runs until the first line that is neither indented nor blank.
	let end = start + 1
	while (
		end < lines.length &&
		(/^\s+\S/.test(lines[end] ?? "") || (lines[end] ?? "").trim() === "")
	) {
		end += 1
	}
	const existing = lines.findIndex(
		(line, i) =>
			i > start &&
			i < end &&
			new RegExp(`^\\s+['"]?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?\\s*:`).test(line),
	)
	if (existing !== -1) {
		lines[existing] = entry
		return `${lines.join("\n")}\n`
	}
	lines.splice(end, 0, entry)
	return `${lines.join("\n")}\n`
}

export function writeForcedVersion(
	raw: string,
	file: string,
	pkg: string,
	patchedVersion: string,
	opts: { scopeToRange?: string; workspaceYaml?: string; packageManager?: string } = {},
): {
	text: string
	label: string
	key: string
	target: "package.json" | "pnpm-workspace.yaml"
} | null {
	let field: string[]
	let label: string
	switch (file) {
		case "package-lock.json":
		case "npm-shrinkwrap.json":
			field = ["overrides"]
			label = "overrides"
			break
		case "pnpm-lock.yaml": {
			// WHICH FILE pnpm READS DEPENDS ON ITS MAJOR. 10+ reads `overrides` from
			// `pnpm-workspace.yaml` and IGNORES the package.json field; 9 and older
			// read `pnpm.overrides` from package.json. A repo that declares its major
			// in `packageManager` gets the file that major reads; one that declares
			// nothing gets the workspace file, because the pnpm that runs here is 12
			// and its answer is the one the lockfile has to agree with.
			const major = Number(/^pnpm@(\d+)/.exec(opts.packageManager ?? "")?.[1] ?? "0")
			if (major > 0 && major < 10) {
				field = ["pnpm", "overrides"]
				label = "pnpm.overrides"
				break
			}
			const key = opts.scopeToRange ? `${pkg}@${opts.scopeToRange}` : pkg
			return {
				text: writeWorkspaceOverride(opts.workspaceYaml ?? "", key, patchedVersion),
				label: "overrides (pnpm-workspace.yaml)",
				key,
				target: "pnpm-workspace.yaml",
			}
		}
		case "yarn.lock":
			if (opts.scopeToRange) return null
			field = ["resolutions"]
			label = "resolutions"
			break
		default:
			return null
	}

	let manifest: Record<string, unknown>
	try {
		manifest = JSON.parse(raw) as Record<string, unknown>
	} catch {
		return null
	}
	if (manifest === null || typeof manifest !== "object") return null

	// Walk (and create) every container except the last segment.
	let block = manifest
	for (const segment of field.slice(0, -1)) {
		const current = block[segment]
		if (current === null || typeof current !== "object") block[segment] = {}
		block = block[segment] as Record<string, unknown>
	}
	const leaf = field[field.length - 1] ?? "overrides"
	const existing =
		block[leaf] !== null && typeof block[leaf] === "object"
			? (block[leaf] as Record<string, unknown>)
			: {}
	const key = opts.scopeToRange ? `${pkg}@${opts.scopeToRange}` : pkg
	block[leaf] = { ...existing, [key]: patchedVersion }

	const indent = /\n([^\S\n]+)"/.exec(raw)?.[1] ?? "	"
	return { text: `${JSON.stringify(manifest, null, indent)}\n`, label, key, target: "package.json" }
}

/**
 * Every version of `pkg` a lockfile still resolves, or `null` when the format is
 * not one this can read (cargo, composer, gem, go, uv).
 *
 * THE POINT IS DISTINGUISHING TWO OUTCOMES THAT LOOK THE SAME. When a forced
 * version produces no diff, either the lockfile still carries a vulnerable copy
 * (a real failure worth a ⚠️) or it carries none at all (the repo is already
 * fixed and the advisory is stale — nobody's work). Reporting both as "needs a
 * human" is what made 6 of 23 alerts sit in a queue nobody could action.
 */
export function lockedVersionsOf(
	workdirs: Workdirs,
	lockPath: string,
	pkg: string,
): string[] | null {
	let raw: string
	try {
		raw = workdirs.readFile(lockPath)
	} catch {
		return null
	}
	if (/^(package-lock\.json|npm-shrinkwrap\.json)$/i.test(basename(lockPath))) {
		try {
			const lock = JSON.parse(raw) as { packages?: Record<string, { version?: string }> }
			const out: string[] = []
			for (const [path, entry] of Object.entries(lock.packages ?? {})) {
				// Every nesting depth, not just the root: the whole reason this check
				// exists is a vulnerable copy nested under another package.
				if (!path.endsWith(`node_modules/${pkg}`)) continue
				if (typeof entry?.version === "string") out.push(entry.version)
			}
			return out
		} catch {
			return null
		}
	}
	if (/^cargo\.lock$/i.test(basename(lockPath))) {
		// TOML, read block by block: Cargo.lock is a list of `[[package]]` tables
		// and the key order inside one is not guaranteed.
		const out: string[] = []
		for (const block of raw.split("[[package]]").slice(1)) {
			const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1]
			const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1]
			if (name === pkg && version) out.push(version)
		}
		return out
	}
	if (/^composer\.lock$/i.test(basename(lockPath))) {
		try {
			const lock = JSON.parse(raw) as {
				packages?: { name?: string; version?: string }[]
				"packages-dev"?: { name?: string; version?: string }[]
			}
			const out: string[] = []
			for (const entry of [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])]) {
				if (entry?.name === pkg && typeof entry.version === "string") out.push(entry.version)
			}
			return out
		} catch {
			return null
		}
	}
	if (/^pnpm-lock\.yaml$/i.test(basename(lockPath))) {
		// pnpm writes one key per resolved instance — `  minimatch@10.0.1:` — under
		// `packages:` (v6) or `snapshots:` (v9). Both are indented keys, so one
		// pattern covers both without a YAML parser (this bundle has none).
		const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const re = new RegExp(`^\\s+'?${escaped}@([^:'"\\s(]+)'?:`, "gm")
		const out: string[] = []
		for (const match of raw.matchAll(re)) if (match[1]) out.push(match[1])
		return out
	}
	return null
}

/**
 * Close the alerts whose advisory no longer describes the repo.
 *
 * WHY DISMISS AT ALL. `alreadyPatched` means the lockfile resolves nothing
 * vulnerable, yet GitHub still lists the alert — because Dependabot's view is
 * updated on its own schedule, and for a manifest it never re-read the alert can
 * outlive the problem by days. Leaving it open is not neutral: it is the reason a
 * dashboard shows a number that nobody can action, and the reason the same plan is
 * re-examined every run.
 *
 * `dismissed_reason: "inaccurate"` with the lockfile evidence in the comment is
 * the honest one — the advisory is not being tolerated, it is being contradicted by
 * measurement. If the App lacks `dependabot_alerts: write` the PATCH answers 403
 * and this reports that instead of pretending it worked.
 */
export async function dismissStaleAlerts(
	api: GhClient,
	repo: string,
	token: string,
	alertNumbers: readonly number[],
	comment: string,
): Promise<{ dismissed: number; blocked: number }> {
	let dismissed = 0
	let blocked = 0
	for (const number of alertNumbers) {
		const res = await api.request("PATCH", `/repos/${repo}/dependabot/alerts/${number}`, {
			token,
			json: { state: "dismissed", dismissed_reason: "inaccurate", dismissed_comment: comment },
		})
		if (res.status === 200) dismissed += 1
		else blocked += 1
	}
	return { dismissed, blocked }
}

/**
 * The packages a composer conflict names as the reason it cannot proceed.
 *
 * MEASURED on AETHRA-Organizer-Website: `composer update phpunit/phpunit -W`
 * still fails with "pestphp/pest is locked to version v3.8.2 … conflicts with
 * phpunit/phpunit 11.5.50", because `-W` moves the DEPENDENCIES of the package
 * being bumped, not the packages that depend ON it. Naming `pestphp/pest` in the
 * command is what moves it — measured on the same repo, that command completed
 * and resolved phpunit 11.5.50.
 *
 * Only names composer prints in a conflict line are taken, never `php` or an
 * `ext-*` platform requirement, and at most three: this is a targeted widening
 * of one command, not a licence to rewrite the whole dependency graph.
 */
export function composerBlockers(output: string, pkg: string): string[] {
	const out: string[] = []
	for (const line of output.split("\n")) {
		if (!/locked to version|conflicts with|requires|satisfiable by/i.test(line)) continue
		for (const match of line.matchAll(/([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)/g)) {
			const name = match[1] ?? ""
			if (name === pkg || name.startsWith("ext-") || name.startsWith("lib-")) continue
			if (!out.includes(name)) out.push(name)
		}
	}
	return out.slice(0, 3)
}

/**
 * A short, stable discriminator for a plan's MANIFEST, or "" for the legacy case.
 *
 * THE UNIT OF WORK IS `(manifest, package)`, so the branch must identify the
 * manifest too. It used to be `pkg@version` alone, which meant the SAME package
 * on two manifests produced the SAME branch: the first plan opened a PR, and the
 * second found that PR via `openPrForBranch` and reported "already open as
 * PR #n" — so the second manifest was never fixed, and the report said it was.
 * That is exactly the silent half-fix `planVulnFixes`' grouping comment forbids.
 *
 * `package-lock.json` at the repo root keeps its historical, human-readable
 * branch (`fix/vuln-lodash-4.17.21`), because that is the overwhelmingly common
 * case and existing open PRs use that name — changing it would orphan them and
 * open a duplicate. Everything else (a nested manifest, or a root
 * `npm-shrinkwrap.json`) carries a hash of its path.
 */
function manifestDiscriminator(plan: VulnFixPlan): string {
	const base = plan.manifestPath.slice(plan.manifestPath.lastIndexOf("/") + 1)
	if (plan.directory === "/" && base === "package-lock.json") return ""
	const hash = createHash("sha256").update(plan.manifestPath).digest("hex").slice(0, 8)
	return `-${hash}`
}

/** The shared `<pkg>-<version><manifest-discriminator>` slug for a plan. */
function unitSlug(plan: VulnFixPlan): string {
	const base = `${plan.packageName}-${plan.patchedVersion}`
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 60)
	return `${base || "dependency"}${manifestDiscriminator(plan)}`
}

/**
 * True when the repo pins a Yarn 2+ ("Berry") release in `packageManager`.
 *
 * YARN NEEDS TWO COMMAND FORMS and the caller has to say which, because the two
 * majors treat each other's flag as a WARNING rather than an error: Yarn 1 has
 * no `up`, Berry has no `upgrade`, and the wrong one exits 0 WITHOUT touching
 * the lockfile — which the no-diff check then reports as "resolved nothing".
 * So a Berry repo was never fixable by this flow.
 *
 * The declaration lives in the ROOT `package.json`'s `packageManager` field
 * (`"yarn@4.1.0"`), which is why the root is read first even when the manifest
 * is nested. Unreadable or absent means Yarn 1 — the far more common shape, and
 * the form this flow shipped with.
 */
function isYarnBerry(workdirs: Workdirs, workdir: string, cwd: string): boolean {
	for (const path of [`${workdir}/package.json`, `${cwd}/package.json`]) {
		try {
			const manifest = JSON.parse(workdirs.readFile(path)) as { packageManager?: unknown }
			const declared = manifest.packageManager
			if (typeof declared !== "string") continue
			const major = Number(/^yarn@(\d+)/.exec(declared)?.[1] ?? "0")
			return Number.isFinite(major) && major >= 2
		} catch {
			// Not readable / not JSON: fall through to the next candidate.
		}
	}
	return false
}

/** A branch name GitHub will accept: no `@`, no `/` from a scoped package. */
export function vulnBranchName(plan: VulnFixPlan): string {
	return `fix/vuln-${unitSlug(plan)}`
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
	opts: { legacyPeerDeps?: boolean; overrides?: boolean; yarnBerry?: boolean } = {},
): string {
	const advisories = plan.ghsaIds.length ? plan.ghsaIds.join(", ") : "security advisory"
	const links = plan.alertNumbers
		.map((n) => `- [alert #${n}](${alertUrl(plan.repo, n)})`)
		.join("\n")
	// THE COMMAND IN THE BODY MUST BE THE ONE THAT WAS RUN.
	//
	// On the `overrides` route the worker runs `npm install --package-lock-only`
	// with NO package argument, because the override in `package.json` is what
	// drives resolution. The body used to print `fixCommandFor`'s plain form —
	// `npm install … <pkg>@<version>` — which is precisely the PROMOTION the
	// paragraph above it says was avoided. A reviewer re-running that command
	// would add the package to `dependencies` and reproduce a different diff
	// from the one under review.
	const command = fixCommandFor(plan, { yarnBerry: opts.yarnBerry })
	const argv =
		opts.overrides && "argv" in command
			? ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]
			: "argv" in command
				? command.argv
				: null
	const commandLine = argv ? argv.join(" ") : "(no automatic command)"
	return (
		`Bumps \`${plan.packageName}\` to **${plan.patchedVersion}** in \`${plan.manifestPath}\` ` +
		`to clear ${advisories} (${plan.severity || "unknown"} severity).\n\n` +
		`${links}\n\n` +
		`All alerts on this page: ${dependabotUrl(plan.repo)}\n\n` +
		`Opened by pr-queue-worker: \`automated-security-fixes\` was enabled on this repo and ` +
		`the advisory had a published patched version, but no PR had been opened for it, so the ` +
		`worker applied the update itself. The lockfile is the only file this PR should touch; ` +
		`CI and the normal review gate decide whether it merges.\n\n` +
		(opts.overrides
			? `\n**Pinned with \`overrides\`.** The advisory is on a TRANSITIVE dependency, ` +
				`and \`npm install <pkg>@<version>\` would "fix" it by promoting the package into ` +
				`\`dependencies\` — a change to this repo's dependency contract that the advisory ` +
				`did not ask for. The \`overrides\` entry is npm's own idiom: the dependency list ` +
				`stays as it is, the lockfile resolves the vulnerable package to the patched ` +
				`version, and \`npm ci\` honours it.\n`
			: "") +
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
	/** Plans that genuinely need a decision (no command, unreadable manifest, …). */
	manual: number
	/** Plans whose advisory is stale: the lockfile resolves nothing vulnerable. */
	alreadyPatched: number
	/** Plans whose patch no reachable version can contain (upstream). */
	blockedUpstream: number
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
	/**
	 * Close alerts that measurement proved stale (default on).
	 *
	 * Off only for a caller that must not touch alert state at all; the dismissal
	 * is guarded by the lockfile evidence that produced `alreadyPatched`, so the
	 * default is safe.
	 */
	dismissStale?: boolean
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
 *
 * THREE ANSWERS, NOT TWO. `0` means "no PR, go ahead"; a positive number is the
 * PR that already exists; `null` means the lookup ANSWERED but the answer could
 * not be read (a row with no numeric `number`). The old code folded that third
 * case into `-1` and the caller treated anything non-zero as "already open",
 * so a malformed reply reported `already open as PR #-1` and the plan was
 * counted as DONE — a fix that was never attempted, reported as one that was.
 * A failed REQUEST (non-200, non-array) is different: it returns `0`, and the
 * subsequent POST answers 422 for a real duplicate, which is handled as success.
 */
async function openPrForBranch(
	api: GhClient,
	repo: string,
	branch: string,
	token: string,
): Promise<number | null> {
	const owner = repo.split("/")[0] ?? ""
	const { status, data } = await api.request(
		"GET",
		`/repos/${repo}/pulls?state=open&head=${owner}:${branch}&per_page=1`,
		{ token },
	)
	if (status !== 200 || !Array.isArray(data) || data.length === 0) return 0
	const n = Number((data[0] as { number?: number })?.number)
	return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * True when a `git status --porcelain` body names `path` as a whole path.
 *
 * The lines are `XY <path>`, and a rename is `XY <old> -> <new>`; both sides are
 * considered, because either means this file changed. Compared EXACTLY: a
 * substring test let a root `package-lock.json` plan pass on a change to
 * `apps/web/package-lock.json`.
 */
function porcelainTouches(stdout: string, path: string): boolean {
	for (const raw of stdout.split("\n")) {
		const line = raw.trimEnd()
		if (line.length < 4) continue
		// Two status columns, one space, then the path.
		const rest = line.slice(3)
		const [from, to] = rest.split(" -> ")
		if (from === path || (to !== undefined && to === path)) return true
	}
	return false
}

/**
 * The remote head of `branch`, or "" when it does not exist (or cannot be read).
 *
 * Used ONLY to decide whether a push needs a lease. An unreadable answer is ""
 * — a plain push — which is the pre-existing behaviour and cannot discard
 * anything; the force path is reached only on a positive "the branch is there".
 */
async function existingBranchHead(
	api: GhClient,
	repo: string,
	branch: string,
	token: string,
): Promise<string> {
	try {
		const { status, data } = await api.request("GET", `/repos/${repo}/git/ref/heads/${branch}`, {
			token,
		})
		if (status !== 200) return ""
		const sha = (data as { object?: { sha?: unknown } } | null)?.object?.sha
		return typeof sha === "string" ? sha : ""
	} catch {
		return ""
	}
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
): Promise<{
	ok: boolean
	prUrl?: string
	detail: string
	manual?: boolean
	/**
	 * True when the lockfile resolves NO vulnerable copy of the package: the
	 * advisory is stale and there is nothing for anyone to do.
	 *
	 * Distinct from `manual` on purpose. `manual` means "a decision is needed";
	 * this means "the question is already closed", and the two used to be reported
	 * with the same ℹ️ line — which is how 6 of 23 alerts looked like a backlog
	 * when they were either fixed already or one override away from being fixed.
	 */
	alreadyPatched?: boolean
	/**
	 * True when the update ran and the lockfile STILL resolves a vulnerable copy:
	 * the patch is outside what this manifest can reach.
	 *
	 * Not a human decision and not a failure of the run. MEASURED on zeavis-edu's
	 * `glib`: the advisory's patch is 0.20.0, the crate that pulls glib is
	 * `gtk ^0.18` under `tauri 2.12.5` (the newest 2.x), and the newest gtk on
	 * crates.io is 0.19.0 — so no reachable version combination contains the fix.
	 * The next run re-checks it for free, and the PR appears by itself the day
	 * upstream ships a compatible release.
	 */
	blockedUpstream?: boolean
	/**
	 * True when this plan needed no work because its PR already exists.
	 *
	 * The caller's per-repo cap counts PRs it OPENED, not plans it looked at, so
	 * this must not consume budget — otherwise a repo whose first N plans are
	 * already open would skip every remaining plan as "left for the next run",
	 * on this run and every later one, and the genuinely unfixed alerts behind
	 * them would starve forever.
	 */
	alreadyOpen?: boolean
}> {
	const { run, exec, workdirs, api } = deps
	const branch = vulnBranchName(plan)
	// `_vuln_` INFIX: the lockfix/autofix clones under TMP_BASE are swept by
	// `sweepStale` against the open-PR set, and a directory that does not match
	// that naming would either be swept as an orphan or never swept at all. This
	// flow removes its own workdir on every exit path, so the infix keeps the two
	// families apart instead of relying on the sweep to guess.
	//
	// The slug carries the manifest discriminator for the same reason as the
	// branch: two plans for one package on two manifests must not share a
	// workdir either, or the second would act on the first's clone.
	const workdir = `${TMP_BASE}/_vuln_${plan.repo.replace(/\//g, "_")}_${unitSlug(plan)}`

	const existing = await openPrForBranch(api, plan.repo, branch, opts.token)
	if (existing === null) {
		// The lookup answered, but not with a PR number. Do not claim the work is
		// done (the old `-1` did exactly that) and do not push either: the next
		// run re-asks.
		return {
			ok: false,
			detail: `could not read the existing-PR lookup for ${branch} — deferring this plan`,
		}
	}
	if (existing > 0)
		return { ok: true, alreadyOpen: true, detail: `already open as PR #${existing}` }

	workdirs.remove(workdir)
	workdirs.mkdir(workdir)
	const cloned = clonePr(run, plan.repo, opts.defaultBranch, opts.token, workdir, CLONE_DEPTH)
	if (cloned.code !== 0) {
		workdirs.remove(workdir)
		return { ok: false, detail: `clone failed: ${head(reportable(cloned.stderr), 200)}` }
	}

	// The cwd first, because the Yarn form depends on the tree that was just
	// cloned (its root `package.json` declares the major).
	const cwd = plan.directory === "/" ? workdir : `${workdir}${plan.directory}`
	const yarnBerry = isYarnBerry(workdirs, workdir, cwd)
	const command = fixCommandFor(plan, { yarnBerry })
	if (!("argv" in command)) {
		workdirs.remove(workdir)
		return { ok: false, manual: true, detail: command.manual }
	}

	// npm CANNOT PIN A TRANSITIVE DEPENDENCY FROM THE COMMAND LINE.
	//
	// Measured on BotWa: `npm install --package-lock-only brace-expansion@1.1.21`
	// satisfies the advisory by ADDING `"brace-expansion": "^1.1.21"` to
	// `dependencies` — it promotes a transitive package to a direct one, changing
	// the repo's dependency contract without anyone asking. `--no-save` is not the
	// answer either: measured, it leaves the lockfile untouched ("up to date"), so
	// the fix would be a no-op. `overrides` is npm's own idiom for this exact
	// case — the dependency list stays as it is, the lockfile resolves the
	// vulnerable package to the patched version, and `npm ci` honours it.
	const file = basename(plan.manifestPath).toLowerCase()
	const pkgPath = `${cwd}/package.json`
	const isNpmLock = /^(package-lock\.json|npm-shrinkwrap\.json)$/i.test(file)
	let overrideWritten = false
	let overrideLabel = ""
	let argv = command.argv
	// The peer-conflict retry has to follow the SAME route. Carrying the original
	// `argv` into the retry after switching to `overrides` re-runs the plain
	// `npm install <pkg>@<ver>` — which is exactly the promotion the override
	// exists to avoid. Measured on BotWa #24: the override landed AND
	// `"brace-expansion": "^1.1.21"` was added to `dependencies` by the retry.
	let fallback: string[] | undefined = "fallback" in command ? command.fallback : undefined
	const retryOn = "retryOn" in command ? command.retryOn : undefined

	/**
	 * Write the forced version into `package.json` and switch the command to a
	 * plain install.
	 *
	 * SCOPED WHEN THE PACKAGE IS ALSO A DIRECT DEPENDENCY, because an unscoped
	 * override pins EVERY copy — including the one the app imports. When that copy
	 * is already at or above the patched version, pinning it is a DOWNGRADE: the
	 * BotWa `axios` shape this flow was built to prevent. Scoped to the advisory's
	 * own vulnerable range, only the copies that are actually vulnerable move.
	 *
	 * Returns the field it wrote (`overrides`, `pnpm.overrides`, `resolutions`), or
	 * null when this ecosystem has no override mechanism — cargo, composer, gem,
	 * go and uv have none, and for those the caller keeps the manual report.
	 */
	const workspacePath = `${workdir}/pnpm-workspace.yaml`
	const forceVersion = (): string | null => {
		let raw: string
		try {
			raw = workdirs.readFile(pkgPath)
		} catch {
			return null
		}
		let manifest: Record<string, unknown>
		try {
			manifest = JSON.parse(raw) as Record<string, unknown>
		} catch {
			return null
		}
		// Absent is normal: most repos have no pnpm settings file until pnpm 10+
		// needs one, and that is where pnpm 12 reads `overrides` from.
		let workspaceYaml = ""
		try {
			workspaceYaml = workdirs.readFile(workspacePath)
		} catch {
			workspaceYaml = ""
		}
		const written = writeForcedVersion(raw, file, plan.packageName, plan.patchedVersion, {
			...(npmDirectRange(manifest, plan.packageName) !== null && plan.vulnerableRange !== ""
				? { scopeToRange: plan.vulnerableRange }
				: {}),
			workspaceYaml,
			packageManager:
				typeof manifest.packageManager === "string" ? (manifest.packageManager as string) : "",
		})
		if (!written) return null
		workdirs.writeFile(
			written.target === "pnpm-workspace.yaml" ? workspacePath : pkgPath,
			written.text,
		)
		overrideWritten = true
		overrideLabel = written.label
		argv = installOnlyFor(file)
		// npm's peer-conflict escape hatch only exists for npm; carrying it into a
		// pnpm command would be a flag pnpm rejects outright.
		fallback = file === "pnpm-lock.yaml" ? undefined : [...argv, "--legacy-peer-deps"]
		return written.label
	}

	if (isNpmLock) {
		const pkgPath = `${cwd}/package.json`
		let manifest: Record<string, unknown>
		let raw = ""
		try {
			raw = workdirs.readFile(pkgPath)
			manifest = JSON.parse(raw) as Record<string, unknown>
		} catch {
			workdirs.remove(workdir)
			return {
				ok: false,
				manual: true,
				detail: `could not read ${plan.directory === "/" ? "" : plan.directory.slice(1)}package.json as JSON — the npm update needs it`,
			}
		}
		const directRange = npmDirectRange(manifest, plan.packageName)
		if (directRange !== null) {
			// A DIRECT DEPENDENCY IS A DIFFERENT DECISION, and this is the one that
			// went wrong in the first live run: BotWa's `axios` was a direct
			// dependency at `^1.21.1` while the advisories were on 0.x copies nested
			// under `dhn-api` and `wa-sticker-formatter`. `npm install axios@0.33.0`
			// "fixed" it by rewriting the DIRECT range to `^0.33.0` — a downgrade of
			// the package the app itself imports — and left the nested copies exactly
			// as they were. The PR passed CI and was merged.
			//
			// So: only move a direct dependency FORWARD, and refuse when the patched
			// version is not ahead of what is installed, because then the vulnerable
			// instance is somewhere else in the tree and bumping its parent is the
			// fix — a decision with a blast radius this flow cannot judge.
			// The lockfile the PLAN names, not a hard-coded `package-lock.json`: an
			// `npm-shrinkwrap.json` repo has no package-lock at all, and reading the
			// wrong path returned null — which used to fall through to the forward
			// move below. See the `locked === null` arm for why that was unsafe.
			const locked = npmLockedVersion(
				workdirs,
				`${cwd}/${basename(plan.manifestPath)}`,
				plan.packageName,
			)
			// CANNOT TELL IS NOT "MOVE IT". `npmLockedVersion` documents that its
			// null means "do not move it", but the guard below only refused when the
			// version was READABLE and not ahead — so an unparseable or absent
			// lockfile fell through to `npm install <pkg>@<patched>`, which rewrites
			// the DECLARED range. On a direct dependency that can be a DOWNGRADE of
			// the package the app imports (the BotWa `axios` shape this whole block
			// exists to prevent), decided on no evidence at all. A human has to look.
			if (locked === null) {
				workdirs.remove(workdir)
				return {
					ok: false,
					manual: true,
					detail:
						`${plan.packageName} is a direct dependency but its installed version could not be read ` +
						`from ${basename(plan.manifestPath)} — refusing to move it blind, because npm would ` +
						`rewrite the declared range and could downgrade the package the app imports`,
				}
			}
			if (compareVersions(plan.patchedVersion, locked) <= 0) {
				// THE NESTED CASE, AND IT IS FIXABLE WITHOUT A HUMAN. The direct copy
				// is already safe; the vulnerable one is somewhere below it, pulled by
				// another package. An UNSCOPED override would drag the safe copy DOWN
				// to the patch — which is why this used to stop here — but a scoped
				// one (`minimatch@<11.0.1`) only touches the copies whose declaring
				// range can still resolve a vulnerable version. Measured on web1's
				// `minimatch`: direct 11.0.1, vulnerable copy nested under a parent.
				const forced = forceVersion()
				if (forced === null) {
					workdirs.remove(workdir)
					return {
						ok: false,
						manual: true,
						detail:
							`${plan.packageName} is a direct dependency already at ${locked}; the vulnerable copy is ` +
							`nested under another package, and this manifest has no override field to force it with`,
					}
				}
			}
			// Forward move: npm rewrites the declared range and the lockfile together.
		} else {
			// TRANSITIVE: npm cannot pin it from the command line without promoting
			// it to a direct dependency, so the override is the fix. `forceVersion`
			// writes it with the file's own indentation and switches the command to a
			// plain install.
			if (forceVersion() === null) {
				workdirs.remove(workdir)
				return {
					ok: false,
					manual: true,
					detail: `could not write an overrides entry for ${plan.packageName} into ${basename(pkgPath)}`,
				}
			}
		}
	}

	const [program, ...args] = argv
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
		// direct dependency`. Measured on Pemrograman-web-1's `minimatch`.
		//
		// ITS OWN ANSWER IS `pnpm.overrides`, so use it. This used to stop here with
		// "which is a human's call", which was the wrong reading: the entry lives in
		// `package.json` and is committed with the branch, so CI's
		// `--frozen-lockfile` accepts the resulting lockfile — the same mechanism the
		// npm path has always used for the identical situation.
		if (/ERR_PNPM_UPDATE_VERSION_ON_INDIRECT_DEP/.test(why) && !overrideWritten) {
			const forced = forceVersion()
			if (forced === null) {
				workdirs.remove(workdir)
				return {
					ok: false,
					manual: true,
					detail: `${plan.packageName} is a TRANSITIVE dependency — pnpm will not pin it, and ${basename(pkgPath)} could not take a pnpm.overrides entry`,
				}
			}
			const [fprogram, ...fargs] = argv
			updated = exec([fprogram ?? "", ...fargs], cwd, UPDATE_TIMEOUT_SEC)
			if (updated.code !== 0) {
				workdirs.remove(workdir)
				const failWhy = reportable((updated.stderr || updated.stdout || "").trim())
				return {
					ok: false,
					detail: `${fprogram} exited ${updated.code} after writing ${forced}: ${head(failWhy, 300)}`,
				}
			}
		} else if (/ERR_PNPM_UPDATE_VERSION_ON_INDIRECT_DEP/.test(why)) {
			workdirs.remove(workdir)
			return {
				ok: false,
				detail: `${plan.packageName} is still refused by pnpm as an indirect dependency after ${overrideLabel}`,
			}
		}
		// CARGO: THE PATCH CAN SIT OUTSIDE THE PARENT'S REQUIREMENT.
		// MEASURED on zeavis-edu: `cargo update -p glib --precise 0.20.0` fails with
		// "failed to select a version for the requirement `glib = \"^0.18\"` …
		// required by package `gtk v0.18.2`". Nothing is wrong with the command —
		// the crate that pulls glib pins the 0.18 line. `cargo update -p gtk` is the
		// escalation: it moves the PARENT and lets the child follow. Whether that
		// reaches the patch is checked below, before any PR is opened.
		if (/failed to select a version for the requirement/.test(why) && file === "cargo.lock") {
			const parent = /required by package `([A-Za-z0-9_.-]+) v/.exec(why)?.[1]
			if (parent !== undefined && parent !== plan.packageName) {
				updated = exec(["cargo", "update", "-p", parent], cwd, UPDATE_TIMEOUT_SEC)
				if (updated.code !== 0) {
					workdirs.remove(workdir)
					const failWhy = reportable((updated.stderr || updated.stdout || "").trim())
					return {
						ok: false,
						detail: `${plan.packageName} is pinned by ${parent}, and moving ${parent} failed: ${head(failWhy, 300)}`,
					}
				}
			}
		}
		// One retry, only for the reason this command declares. Anything else is the
		// repo's own problem and retrying it just doubles the run time.
		if (updated.code !== 0 && fallback && (retryOn ?? /ERESOLVE|peer dep/i).test(why)) {
			const [fprogram, ...fargs] = fallback
			updated = exec([fprogram ?? "", ...fargs], cwd, UPDATE_TIMEOUT_SEC)
			usedFallback = updated.code === 0
			if (!usedFallback) {
				// THIRD ATTEMPT, COMPOSER ONLY: NAME WHAT BLOCKS IT. `-W` moves the
				// dependencies of the package being bumped; a package that DEPENDS on
				// it has to be named in the command (measured on AETHRA's pest).
				const blockers =
					fprogram === "composer"
						? composerBlockers(`${updated.stderr}${updated.stdout}`, plan.packageName)
						: []
				if (blockers.length > 0) {
					updated = exec(
						[
							"composer",
							"update",
							plan.packageName,
							...blockers,
							"--with-all-dependencies",
							"--no-interaction",
							"--no-scripts",
							"--ignore-platform-req=php",
						],
						cwd,
						UPDATE_TIMEOUT_SEC,
					)
				}
				if (updated.code !== 0) {
					workdirs.remove(workdir)
					const failWhy = reportable((updated.stderr || updated.stdout || "").trim())
					return {
						ok: false,
						manual: true,
						detail:
							`${fprogram} still cannot resolve ${plan.packageName} ${plan.patchedVersion}` +
							`${blockers.length > 0 ? ` with ${blockers.join(", ")} moved too` : ""}: ${head(failWhy, 300)}`,
					}
				}
			}
		} else if (updated.code !== 0) {
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
	// THE MANIFEST MUST HAVE MOVED, not just any file. With an `overrides` entry
	// written above, `package.json` is dirty whether or not the lockfile was
	// re-resolved — a check for "any change" would happily ship a PR that adds an
	// override and fixes nothing.
	// EXACT PATH MATCH, NOT A SUBSTRING. `status.stdout.includes(manifestPath)`
	// also matched a NESTED manifest: a plan for the root `package-lock.json`
	// "found" its change in `apps/web/package-lock.json`, so a PR was opened
	// claiming the root was fixed when the root file had not moved at all — the
	// silent half-fix the (manifest, package) grouping exists to prevent. Each
	// porcelain line is `XY <path>`, so the path is compared as a whole segment
	// (a rename line's `old -> new` form counts when either side matches).
	const moved = (): boolean => {
		const status = run(["status", "--porcelain"], workdir, 60)
		return status.code === 0 && porcelainTouches(status.stdout, plan.manifestPath)
	}

	// ATTEMPT 2: FORCE IT.
	//
	// A plain update exits 0 having resolved NOTHING when the manifest does not
	// name the package and a parent's range pins the copy it keeps — measured on
	// GMW's `esbuild` and `undici`, TeleUploader's and zeavis-edu's `esbuild`. The
	// command is not wrong; there is simply nothing for it to move. The override
	// is the answer, and it is the same entry the npm and pnpm routes above write.
	//
	// This used to be the end of the line ("needs a human"), which put 6 of 23
	// alerts in a queue that nothing ever drained.
	let forcedNow = false
	if (!moved() && !overrideWritten) {
		const label = forceVersion()
		if (label !== null) {
			const [fprogram, ...fargs] = argv
			const forced = exec([fprogram ?? "", ...fargs], cwd, UPDATE_TIMEOUT_SEC)
			forcedNow = forced.code === 0
			if (!forcedNow) {
				workdirs.remove(workdir)
				const failWhy = reportable((forced.stderr || forced.stdout || "").trim())
				return {
					ok: false,
					detail: `${fprogram} exited ${forced.code} after writing ${label}: ${head(failWhy, 300)}`,
				}
			}
		}
	}

	if (!moved()) {
		// NOTHING MOVED, EVEN WITH THE FORCE. Two outcomes that look identical and
		// are not:
		//   - the lockfile still resolves a vulnerable copy → a real failure, and
		//     the versions are named so the next run has something to go on;
		//   - the lockfile resolves nothing vulnerable → the repo is ALREADY FIXED
		//     and the advisory is stale. That is not work for a human, it is a
		//     closed question.
		const versions = lockedVersionsOf(
			workdirs,
			`${cwd}/${basename(plan.manifestPath)}`,
			plan.packageName,
		)
		const vulnerable = (versions ?? []).filter((v) => compareVersions(v, plan.patchedVersion) < 0)
		workdirs.remove(workdir)
		if (versions !== null && vulnerable.length === 0) {
			return {
				ok: false,
				alreadyPatched: true,
				detail:
					versions.length === 0
						? `${basename(plan.manifestPath)} resolves no copy of ${plan.packageName} at all — the advisory is stale`
						: `${basename(plan.manifestPath)} resolves only ${[...new Set(versions)].join(", ")}, all at or above ${plan.patchedVersion} — the advisory is stale`,
			}
		}
		if (vulnerable.length > 0) {
			// The update ran and the vulnerable copy is still there: the patch is
			// outside what this manifest can reach (a parent pins the old line). No
			// human can decide that away either — it is upstream's to release, and
			// the next run re-checks it for free.
			return {
				ok: false,
				blockedUpstream: true,
				detail:
					`${basename(plan.manifestPath)} still resolves ${[...new Set(vulnerable)].join(", ")} — ` +
					`${plan.patchedVersion} is not reachable from this manifest yet`,
			}
		}
		return {
			ok: false,
			manual: true,
			detail:
				`the package manager resolved nothing (${program} exited 0)${forcedNow ? ` even with ${overrideLabel}` : ""}` +
				", and the lockfile could not be read to tell whether anything is still vulnerable",
		}
	}

	// A MOVED LOCKFILE IS NOT A FIX IF THE VULNERABLE VERSION IS STILL IN IT.
	// The cargo escalation above (`cargo update -p gtk`) moves the lockfile
	// without necessarily reaching the patch — measured on zeavis-edu, where glib
	// stays at 0.18.5 because gtk 0.18 pins the whole 0.18 line. Opening a PR for
	// that would attach a "fix" to an advisory it does not fix, which is the
	// silent half-fix this module must not produce.
	const stillThere = (
		lockedVersionsOf(workdirs, `${cwd}/${basename(plan.manifestPath)}`, plan.packageName) ?? []
	).filter((v) => compareVersions(v, plan.patchedVersion) < 0)
	if (stillThere.length > 0) {
		workdirs.remove(workdir)
		return {
			ok: false,
			blockedUpstream: true,
			detail:
				`${basename(plan.manifestPath)} still resolves ${[...new Set(stillThere)].join(", ")} after the update — ` +
				`${plan.patchedVersion} is outside what this manifest can reach`,
		}
	}

	const message = `fix(deps): bump ${plan.packageName} to ${plan.patchedVersion} for ${plan.ghsaIds.join(", ") || "security advisory"}`
	// `git add -A` FIRST, not `commit -am`: the forced version can live in a file
	// the repo does not have yet — `pnpm-workspace.yaml` is created when pnpm 10+
	// needs an override, and it is UNTRACKED. `commit -am` stages only tracked
	// files, so the branch would carry the lockfile without the entry that
	// produced it: CI would re-resolve without the override and the PR would
	// claim a fix it does not contain.
	run(["add", "-A"], workdir, 120)
	const committed = run(["commit", "-m", message], workdir, 120)
	if (committed.code !== 0) {
		workdirs.remove(workdir)
		return { ok: false, detail: `commit failed: ${head(reportable(committed.stderr), 200)}` }
	}

	// PAT first, then the App token — the same ordering `git.ts` documents, for
	// the same reason: a branch that touches `.github/workflows/*` is refused for
	// an App without the `workflows` permission, and the PAT has it.
	//
	// FORCED ONLY WHEN THE BRANCH IS OURS TO REPLACE. A previous run can have
	// pushed this branch and then failed to open the PR (a 5xx, a rate limit, a
	// permission blip). The next run re-clones the DEFAULT branch, re-applies the
	// same bump, and pushes to a branch that now exists with a different commit —
	// a non-fast-forward, rejected on every later run, so the plan is wedged
	// forever with nothing in the report to say why. The branch is this flow's
	// own (`fix/vuln-<unit>`), and the lease makes the force safe: it only
	// replaces the exact remote head that was read, so a human's push on top is
	// never discarded.
	const remoteHead = await existingBranchHead(api, plan.repo, branch, opts.token)
	const pushed = pushRef(workdir, plan.repo, "HEAD", `refs/heads/${branch}`, opts.token, false, {
		pat: deps.fetchGhToken(),
		run,
		// A lease forces the update (force-with-lease) and refuses if the remote
		// moved since this read.
		...(remoteHead ? { expectedHeadSha: remoteHead } : {}),
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
			body: buildVulnPrBody(plan, {
				legacyPeerDeps: usedFallback,
				overrides: overrideWritten,
				yarnBerry,
			}),
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
		alreadyPatched: 0,
		blockedUpstream: 0,
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
			if (deps.dry) {
				taken += 1
				summary.skipped += 1
				say(
					`   🧪 dry run: would bump ${plan.packageName} -> ${plan.patchedVersion} on ${plan.manifestPath} (${plan.alertNumbers.length} alert(s))`,
				)
				continue
			}
			const res = await applyPlan(deps, plan, { token: opts.token, defaultBranch })
			// A PLAN WHOSE PR ALREADY EXISTS COSTS NOTHING. Counting it against the
			// cap is how a repo with many open security PRs starves the rest: the
			// first N plans "consume" the budget without opening anything, the rest
			// are deferred, and the next run repeats the same N. The cap bounds PRs
			// OPENED per run, so only a plan that actually reached the point of
			// opening one may increment it.
			if (!res.alreadyOpen) taken += 1
			if (res.ok) {
				summary.opened += 1
				perRepo.opened += 1
				say(
					`   ✅ ${repo}: ${plan.packageName} -> ${plan.patchedVersion} (${plan.alertNumbers.length} alert(s)) ${res.prUrl ?? res.detail}`,
				)
			} else if (res.blockedUpstream) {
				// NOT a human decision and not a failure: the patch exists but no
				// version this manifest can resolve contains it. The timer re-checks
				// every run, so the PR appears by itself when upstream catches up.
				summary.blockedUpstream += 1
				say(
					`   ⛔ ${repo}: ${plan.packageName} -> ${plan.patchedVersion} blocked upstream — ${res.detail}`,
				)
			} else if (res.alreadyPatched) {
				// Not a failure and not a decision: the lockfile no longer resolves
				// anything vulnerable, so the alert is stale.
				summary.alreadyPatched += 1
				// AND CLOSE IT, when the App is allowed to. Otherwise the same stale
				// row is re-examined on every run and keeps the dashboard's number up
				// for a problem the measurement already disproved.
				let note = ""
				if (!deps.dry && deps.dismissStale !== false && plan.alertNumbers.length > 0) {
					const dismissal = await dismissStaleAlerts(
						deps.api,
						repo,
						opts.token,
						plan.alertNumbers,
						`pr-agent-server: ${plan.manifestPath} resolves no version below ${plan.patchedVersion} ` +
							`for ${plan.packageName} (checked after running the package manager), so this advisory ` +
							`no longer applies. Verified automatically, not by assumption.`,
					)
					if (dismissal.dismissed > 0)
						note = ` — ${dismissal.dismissed} alert(s) dismissed as inaccurate`
					if (dismissal.blocked > 0) {
						note += ` — ${dismissal.blocked} could not be dismissed (the App needs \`dependabot_alerts: write\`)`
					}
				}
				say(
					`   ✔️ ${repo}: ${plan.packageName} ${plan.patchedVersion} — nothing vulnerable left, advisory stale (${plan.alertNumbers.length} alert(s))${note}`,
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

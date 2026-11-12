// biome-ignore-all lint/suspicious/noExplicitAny: API payloads are untyped JSON
/**
 * Dependabot security remediation: derive the lanes a repo actually needs, and
 * render the Dependabot config that carries them.
 *
 * THE PROBLEM THIS SOLVES. Dependabot only opens a security-update PR for a
 * manifest that some `updates:` lane points at. A lane is
 * `(package-ecosystem, directory)`, and the shared template declared a handful of
 * ROOT lanes plus `/apps/tauri`. Measured against the live API, that left the
 * majority of this fleet's alerts unreachable: 478 of 630 open alerts sat on
 * manifests no lane named — `Proyek_Klasifikasi_Gambar/requirements.txt`,
 * `best_model_local/requirements.txt`, `rust/Cargo.lock`, `modul6/modul6/pom.xml`
 * and friends. Those alerts would never be actioned no matter how many times
 * "automated security fixes" was switched on, because nothing was watching the
 * file. Enabling a feature is not the same as making it reach the input.
 *
 * WHY DERIVE RATHER THAN HARDCODE. A template listing every nested directory in
 * this fleet would be wrong the first time a repo adds one, and would carry one
 * repo's layout into every fork. Deriving from a repo's OWN open alerts is
 * self-maintaining: a new manifest shows up as alerts, and the next run adds its
 * lane.
 *
 * WHY A LANE FOR A MISSING DIRECTORY IS HARMLESS. Dependabot does not error on a
 * lane whose directory holds no manifest — it finds nothing to update. That is
 * what lets one config serve repos of different shapes, and it is why adding a
 * derived lane cannot break a repo that does not need it.
 */

import type { GhClient } from "../pr/scan.ts"
import { type DependabotAlert, fetchOpenDependabotAlertsResult } from "./security.ts"

export type VulnFixResult = {
	repo: string
	totalAlerts: number
	alertsFixed: number
	prUrl?: string
	details: string[]
}

/** One `(ecosystem, directory)` pair, and how many open alerts sit on it. */
export type Lane = {
	ecosystem: string
	directory: string
	/** Alert count behind this lane. 0 for a lane read out of a template. */
	alerts: number
	/**
	 * How many of those alerts have a patched version to move to.
	 *
	 * A LANE IS ONLY WORTH ADDING IF SOMETHING IN IT CAN BE FIXED. An advisory
	 * with no `first_patched_version` has no release to upgrade to — Dependabot
	 * cannot open a PR for it no matter how many lanes point at the manifest. On
	 * this fleet, 8 alerts across 6 manifests were exactly that, and deriving
	 * lanes from them wrote four lanes (`maven /ProjectBP1`, `/modul6/modul6`,
	 * `/modul7&8/modul7`, `/modul7&8/modul8`) that could never produce anything.
	 *
	 * They are not permanent omissions: when upstream ships a patch the alert
	 * gains a `first_patched_version`, `fixable` becomes non-zero, and the next
	 * nightly run adds the lane. Deriving from the live alert keeps that
	 * automatic.
	 */
	fixable: number
}

/**
 * True when the advisory names a version to move to.
 *
 * The absence of a patched version is the one case where "do nothing" is the
 * correct action, so it is checked explicitly rather than inferred from a
 * failed lookup.
 */
export function hasPatch(alert: DependabotAlert): boolean {
	const patched = alert.security_vulnerability?.first_patched_version?.identifier
	return typeof patched === "string" && patched.trim() !== ""
}

/**
 * The ecosystem names Dependabot accepts in `package-ecosystem`.
 *
 * The alert API reports an ecosystem too, and for most of these it is the same
 * string. It is checked against this list anyway: an unrecognised ecosystem
 * makes GitHub reject the WHOLE config file, which would silently disable
 * dependency updates for that repo — a far worse outcome than leaving one alert
 * unaddressed.
 */
const KNOWN_ECOSYSTEMS = new Set([
	"bundler",
	"cargo",
	"composer",
	"docker",
	"docker-compose",
	"dotnet-sdk",
	"elm",
	"gitsubmodule",
	"github-actions",
	"gomod",
	"gradle",
	"helm",
	"hex",
	"maven",
	"mix",
	"npm",
	"nuget",
	"pip",
	"pub",
	"swift",
	"terraform",
])

/**
 * Alert-API ecosystem -> Dependabot config ecosystem, where they differ.
 *
 * Most are identical. `rust` is not a Dependabot ecosystem at all (it is
 * `cargo`), and it is the one this fleet actually hits: `mytheclipse-crates`
 * reports `rust` while its manifest is `Cargo.lock`.
 */
const ECOSYSTEM_ALIASES: Record<string, string> = {
	rust: "cargo",
	"rust-lang": "cargo",
	python: "pip",
	javascript: "npm",
	node: "npm",
	php: "composer",
	java: "maven",
	golang: "gomod",
	go: "gomod",
	ruby: "bundler",
	dotnet: "nuget",
	"c#": "nuget",
	"gh-actions": "github-actions",
	actions: "github-actions",
}

/** Filename -> ecosystem, for alerts that omit `dependency.package.ecosystem`. */
const MANIFEST_ECOSYSTEM: Record<string, string> = {
	"package.json": "npm",
	"package-lock.json": "npm",
	"pnpm-lock.yaml": "npm",
	"yarn.lock": "npm",
	"npm-shrinkwrap.json": "npm",
	"requirements.txt": "pip",
	pipfile: "pip",
	"pipfile.lock": "pip",
	"pyproject.toml": "pip",
	"poetry.lock": "pip",
	"setup.py": "pip",
	"uv.lock": "pip",
	"cargo.toml": "cargo",
	"cargo.lock": "cargo",
	"composer.json": "composer",
	"composer.lock": "composer",
	"pom.xml": "maven",
	"build.gradle": "gradle",
	"build.gradle.kts": "gradle",
	"go.mod": "gomod",
	"go.sum": "gomod",
	gemfile: "bundler",
	"gemfile.lock": "bundler",
	"pubspec.yaml": "pub",
	"mix.exs": "mix",
	dockerfile: "docker",
}

/**
 * Normalise an ecosystem string to one Dependabot accepts.
 *
 * Returns `undefined` rather than guessing. A lane with a made-up ecosystem is
 * worse than no lane: GitHub rejects the entire config file, so the repo loses
 * the updates it already had.
 */
export function normaliseEcosystem(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined
	const key = raw.trim().toLowerCase()
	const mapped = ECOSYSTEM_ALIASES[key] ?? key
	return KNOWN_ECOSYSTEMS.has(mapped) ? mapped : undefined
}

/** The directory a manifest path lives in, in Dependabot's `/`-rooted form. */
export function directoryOf(manifestPath: unknown): string {
	if (typeof manifestPath !== "string" || manifestPath.trim() === "") return "/"
	const slash = manifestPath.lastIndexOf("/")
	if (slash < 0) return "/"
	const dir = manifestPath.slice(0, slash).trim()
	return dir === "" ? "/" : `/${dir.replace(/^\/+/, "").replace(/\/+$/, "")}`
}

/** The ecosystem of an alert: the API's own answer first, the filename second. */
export function ecosystemOf(alert: DependabotAlert): string | undefined {
	const dep = alert.dependency as
		| { package?: { ecosystem?: unknown }; manifest_path?: unknown }
		| undefined
	const fromApi = normaliseEcosystem(dep?.package?.ecosystem)
	if (fromApi) return fromApi
	const manifest = typeof dep?.manifest_path === "string" ? dep.manifest_path : ""
	const base = manifest.slice(manifest.lastIndexOf("/") + 1).toLowerCase()
	return MANIFEST_ECOSYSTEM[base]
}

/**
 * The lanes a repo's own open alerts say it needs.
 *
 * One lane per `(ecosystem, directory)`, with the alert count that justified it,
 * sorted heaviest first — that is the order an operator wants to read and the
 * order that keeps a diff stable across runs.
 */
export function lanesForAlerts(alerts: readonly DependabotAlert[]): Lane[] {
	const counts = new Map<string, Lane>()
	for (const alert of alerts) {
		const ecosystem = ecosystemOf(alert)
		if (!ecosystem) continue
		const directory = directoryOf(
			(alert.dependency as { manifest_path?: unknown } | undefined)?.manifest_path,
		)
		const key = `${ecosystem}\u0000${directory}`
		const patchable = hasPatch(alert) ? 1 : 0
		const held = counts.get(key)
		if (held) {
			held.alerts += 1
			held.fixable += patchable
		} else {
			counts.set(key, { ecosystem, directory, alerts: 1, fixable: patchable })
		}
	}
	return [...counts.values()].sort(
		(a, b) =>
			b.alerts - a.alerts ||
			a.ecosystem.localeCompare(b.ecosystem) ||
			a.directory.localeCompare(b.directory),
	)
}

/**
 * The lanes worth WRITING: those where at least one alert has a patch to move to.
 *
 * A lane whose alerts are all "no patched version available" cannot produce a PR
 * — the manifest is watched and there is still nothing Dependabot may do. Writing
 * it is a config commit that fixes nothing, and it reads as progress.
 *
 * The omission is temporary by construction: `fixable` comes from the live alert,
 * so the lane appears on the first nightly run after upstream ships a patch.
 */
export function derivableLanes(alerts: readonly DependabotAlert[]): Lane[] {
	return lanesForAlerts(alerts).filter((lane) => lane.fixable > 0)
}

/**
 * The lanes a Dependabot config already declares.
 *
 * A FOCUSED SCAN, not a YAML parse. These files are authored here, the two keys
 * are the only ones that define a lane, and pulling a YAML parser into the
 * worker bundle to read two scalars is not worth it. Whole-line comments are
 * skipped — the template's own prose names ecosystems ("a Laravel app and a Rust
 * service") and must not be read as lanes. A test pins this against the real
 * template file so it cannot drift silently.
 */
export function lanesInConfig(body: string): Lane[] {
	const lanes: Lane[] = []
	let pendingEcosystem: string | undefined
	for (const raw of body.split("\n")) {
		const line = raw.trim()
		if (line === "" || line.startsWith("#")) continue
		const eco = /^-?\s*package-ecosystem:\s*"?([A-Za-z0-9_.-]+)"?\s*$/.exec(line)
		if (eco) {
			pendingEcosystem = eco[1]
			continue
		}
		const dir = /^directory:\s*"?([^"#]+?)"?\s*$/.exec(line)
		if (dir && pendingEcosystem) {
			lanes.push({ ecosystem: pendingEcosystem, directory: dir[1].trim(), alerts: 0, fixable: 0 })
			pendingEcosystem = undefined
		}
	}
	return lanes
}

/** True when a config already declares this exact lane. */
const covers = (lanes: readonly Lane[], need: Lane): boolean =>
	lanes.some((lane) => lane.ecosystem === need.ecosystem && lane.directory === need.directory)

/**
 * The lanes a repo needs and its config does not declare.
 *
 * THIS is the list that decides whether an alert can ever be fixed. An alert on
 * a manifest no lane names is not "pending a Dependabot PR" — it is unreachable.
 */
export function missingLanes(needs: readonly Lane[], existing: readonly Lane[]): Lane[] {
	return needs.filter((need) => !covers(existing, need))
}

/**
 * Render one lane as YAML, indented to sit in the template's `updates:` list.
 *
 * `directory` is double-quoted because real manifest directories here contain
 * characters YAML reads as syntax — `modul7&8/modul8` is the live example, where
 * an unquoted `&` starts an anchor and the whole file is rejected.
 */
function renderLane(lane: Lane): string {
	return [
		`  # Derived from ${lane.alerts} open Dependabot alert${lane.alerts === 1 ? "" : "s"} on`,
		`  # ${lane.directory} — without this lane Dependabot never sees the manifest, so`,
		"  # the advisory can never become a PR. Re-derived on every sync; do not edit.",
		`  - package-ecosystem: "${lane.ecosystem}"`,
		`    directory: "${lane.directory}"`,
		"    schedule:",
		'      interval: "weekly"',
		'      day: "monday"',
		'      time: "06:00"',
		'      timezone: "Asia/Jakarta"',
		'    labels: ["dependencies"]',
		// Security updates ignore this limit, so a CVE is never queued behind
		// routine version bumps; it only bounds the bump PRs.
		"    open-pull-requests-limit: 3",
		"    groups:",
		"      production:",
		'        dependency-type: "production"',
		"      development:",
		'        dependency-type: "development"',
	].join("\n")
}

/**
 * The Dependabot config a repo should have: the shared template, plus a lane for
 * every manifest its own open alerts point at that the template does not cover.
 *
 * Appends to the end of the `updates:` sequence. That is valid YAML here because
 * `updates:` is the last top-level key in the template and its sequence runs to
 * end of file — `renderLane` produces correctly indented sequence items, so the
 * result parses as one longer list.
 *
 * Returns the template unchanged when there is nothing to add, so a converged
 * repo produces no diff and the sync stays silent.
 */
export function withDerivedLanes(template: string, needs: readonly Lane[]): string {
	const missing = missingLanes(needs, lanesInConfig(template))
	if (missing.length === 0) return template
	const body = template.endsWith("\n") ? template : `${template}\n`
	return `${body}\n${missing.map(renderLane).join("\n\n")}\n`
}

/**
 * Group open alerts by manifest path (e.g. package.json, Cargo.lock, composer.lock)
 */
export function groupAlertsByManifest(alerts: DependabotAlert[]): Map<string, DependabotAlert[]> {
	const map = new Map<string, DependabotAlert[]>()
	for (const alert of alerts) {
		const manifest = alert.dependency.manifest_path || "root"
		const list = map.get(manifest) ?? []
		list.push(alert)
		map.set(manifest, list)
	}
	return map
}

/**
 * Generate a security summary report for a repository.
 */
export function summarizeVulns(repo: string, alerts: DependabotAlert[]): string[] {
	if (alerts.length === 0) {
		return [`✅ ${repo}: 0 open Dependabot security alerts`]
	}
	const fixable = alerts.filter(hasPatch).length
	const skipped = alerts.length - fixable
	const lines = [`🛡️  ${repo}: ${alerts.length} open security alert${alerts.length > 1 ? "s" : ""}:`]
	for (const a of alerts.slice(0, 10)) {
		const pkg = a.dependency.package.name
		const patched = a.security_vulnerability.first_patched_version?.identifier
		const cve = a.security_advisory.cve_id ?? a.security_advisory.ghsa_id
		// "no patch" is not a to-do. Spelling it out as skipped stops an operator
		// reading 598 alerts as 598 fixes owed, when 32 of them have no release to
		// move to and nothing Dependabot may do.
		const target = patched ? `-> patch ${patched}` : "-> NO PATCH AVAILABLE (skipped)"
		lines.push(`   - ${pkg} (${cve}, severity: ${a.security_vulnerability.severity}) ${target}`)
	}
	if (alerts.length > 10) {
		lines.push(`   ... and ${alerts.length - 10} more`)
	}
	if (skipped > 0) {
		lines.push(
			`   ↳ ${skipped} of ${alerts.length} have no patched version — nothing to upgrade to, skipped`,
		)
	}
	return lines
}

export type ScanAndFixOptions = {
	dryRun?: boolean
	token: string
	repos?: string[]
}

/**
 * The lanes a repo's LIVE config declares, falling back to the template.
 *
 * WHY THE AUDIT MUST READ THE REPO, NOT THE TEMPLATE. Derived lanes live in each
 * repo's own `.github/dependabot.yml`, not in the shared template. An audit that
 * compared alerts against the template reported every derived lane as still
 * missing — so immediately after a successful `--fix-vulns` wrote ten lanes, the
 * audit still said "485 unreachable" and would have said so forever. The
 * question "can Dependabot see this manifest" is about the file GitHub reads,
 * and that file is the repo's.
 *
 * A repo with no config, or an unreadable one, falls back to the template: that
 * is what the next sync will install, so it is the honest answer for coverage.
 */
export async function repoLanes(
	api: GhClient,
	repo: string,
	token: string,
	fallbackTemplate: string,
): Promise<Lane[]> {
	const res = await api.request("GET", `/repos/${repo}/contents/${DEPENDABOT_CONFIG_PATH}`, {
		token,
	})
	if (res.status === 200) {
		const body = decodeContent(res.data)
		if (body !== undefined && body.trim() !== "") return lanesInConfig(body)
	}
	return lanesInConfig(fallbackTemplate)
}

/** The one path Dependabot reads its configuration from. */
export const DEPENDABOT_CONFIG_PATH = ".github/dependabot.yml"

/** Base64 file contents out of a contents API response, or undefined. */
function decodeContent(data: unknown): string | undefined {
	const content = (data as { content?: unknown } | undefined)?.content
	if (typeof content !== "string") return undefined
	try {
		return Buffer.from(content, "base64").toString("utf8")
	} catch {
		return undefined
	}
}

/**
 * Scan all repositories for open Dependabot alerts.
 *
 * CARRIES THE FAILURE THROUGH. This used to hand back a bare `alerts` array, so a
 * repo whose alerts could not be read was indistinguishable from a clean one —
 * and the audit printed "No open vulnerabilities found across any repository"
 * for a fleet with 630 of them. An audit that reports a clean fleet when it
 * could not read the fleet is worse than no audit: it retires the question.
 */
export async function scanVulns(
	api: GhClient,
	repos: string[],
	token: string,
): Promise<{ repo: string; alerts: DependabotAlert[]; ok: boolean; status: number }[]> {
	const results: { repo: string; alerts: DependabotAlert[]; ok: boolean; status: number }[] = []
	for (const repo of repos) {
		const res = await fetchOpenDependabotAlertsResult(api, repo, token)
		results.push({ repo, alerts: res.alerts, ok: res.ok, status: res.ok ? 200 : res.status })
	}
	return results
}

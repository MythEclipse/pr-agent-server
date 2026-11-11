// biome-ignore-all lint/suspicious/noExplicitAny: test fakes stand in for untyped GitHub payloads
/**
 * Lane derivation — the bridge between "an advisory was raised" and "Dependabot
 * can open a PR for it".
 *
 * THE BUG THESE TESTS PIN. Dependabot only acts on a manifest that some
 * `updates:` lane names, as `(package-ecosystem, directory)`. The shared template
 * named root lanes plus `/apps/tauri`, so on this fleet 478 of 630 open alerts
 * sat on manifests nothing watched: nested `requirements.txt`, `rust/Cargo.lock`,
 * `modul6/modul6/pom.xml`. Switching "automated security fixes" on for those
 * repos looked like success and changed nothing — the advisory could never
 * become a PR because no lane pointed at the file.
 *
 * Every assertion here is about the RENDERED CONFIG, because that is the artefact
 * GitHub acts on. "We derived a lane" is not an outcome; "the config parses and
 * contains the lane" is.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
	directoryOf,
	ecosystemOf,
	lanesForAlerts,
	lanesInConfig,
	missingLanes,
	normaliseEcosystem,
	repoLanes,
	summarizeVulns,
	withDerivedLanes,
} from "../src/ops/vulnFixer.ts"

const TEMPLATE_DIR = join(import.meta.dirname, "..", "src", "ops", "templates")
const template = readFileSync(join(TEMPLATE_DIR, "dependabot.yml"), "utf8")

/**
 * A minimal alert, in the shape the API returns for the fields that matter.
 * The type demands the full payload; nothing under test reads the rest.
 */
const alert = (ecosystem: string, manifestPath: string, pkg = "left-pad") =>
	({
		number: 1,
		state: "open",
		url: "",
		html_url: "",
		created_at: "",
		dependency: { package: { ecosystem, name: pkg }, manifest_path: manifestPath },
		security_advisory: {
			ghsa_id: "GHSA-x",
			cve_id: null,
			summary: "",
			severity: "high",
		},
		security_vulnerability: {
			package: { ecosystem, name: pkg },
			severity: "high",
			vulnerable_version_range: "<1.0.0",
			first_patched_version: { identifier: "1.0.0" },
		},
	}) as any

// ── Path and ecosystem normalisation ─────────────────────────────────────────

describe("manifest paths become Dependabot directories", () => {
	test("a root manifest is `/`, not `''`", () => {
		// An empty string is not a directory Dependabot accepts, and the failure
		// is a rejected config — the whole file, for every lane.
		expect(directoryOf("package-lock.json")).toBe("/")
		expect(directoryOf("")).toBe("/")
		expect(directoryOf(undefined)).toBe("/")
	})

	test("a nested manifest keeps its directory, `/`-rooted", () => {
		expect(directoryOf("Proyek_Klasifikasi_Gambar/requirements.txt")).toBe(
			"/Proyek_Klasifikasi_Gambar",
		)
		expect(directoryOf("modul7&8/modul8/pom.xml")).toBe("/modul7&8/modul8")
	})

	test("deep nesting is preserved, not truncated to the first segment", () => {
		expect(directoryOf("a/b/c/requirements.txt")).toBe("/a/b/c")
	})

	test("a leading slash is not doubled", () => {
		expect(directoryOf("/a/requirements.txt")).toBe("/a")
	})
})

describe("ecosystems are normalised to names Dependabot accepts", () => {
	test("the alert API's `rust` is Dependabot's `cargo`", () => {
		// The live fleet reports `rust` for a `Cargo.lock`. Passing that through
		// makes GitHub reject the config file outright.
		expect(normaliseEcosystem("rust")).toBe("cargo")
		expect(ecosystemOf(alert("rust", "rust/Cargo.lock"))).toBe("cargo")
	})

	test("the ecosystems this fleet actually uses pass through unchanged", () => {
		for (const eco of ["npm", "pip", "cargo", "composer", "maven", "github-actions"]) {
			expect(normaliseEcosystem(eco)).toBe(eco)
		}
	})

	test("an unknown ecosystem is REJECTED, not guessed", () => {
		// A lane with a bogus ecosystem costs the repo its whole config. Refusing
		// to emit the lane costs it one advisory. That trade is not close.
		expect(normaliseEcosystem("brainfuck")).toBeUndefined()
		expect(normaliseEcosystem("")).toBeUndefined()
		expect(normaliseEcosystem(undefined)).toBeUndefined()
		expect(normaliseEcosystem(42)).toBeUndefined()
	})

	test("the manifest filename is the fallback when the API omits the ecosystem", () => {
		const noEco = alert("", "nested/requirements.txt")
		expect(ecosystemOf(noEco)).toBe("pip")
	})
})

// ── Deriving lanes ───────────────────────────────────────────────────────────

describe("lanes derived from a repo's own alerts", () => {
	test("one lane per (ecosystem, directory), not one per alert", () => {
		// 100 alerts on one manifest is ONE lane. Emitting 100 lanes would blow
		// past GitHub's config limits and make the diff unreadable.
		const alerts = Array.from({ length: 100 }, () => alert("npm", "package-lock.json"))
		const lanes = lanesForAlerts(alerts)
		expect(lanes).toHaveLength(1)
		expect(lanes[0]).toMatchObject({ ecosystem: "npm", directory: "/", alerts: 100 })
	})

	test("distinct manifests become distinct lanes", () => {
		const lanes = lanesForAlerts([
			alert("pip", "Proyek_Klasifikasi_Gambar/requirements.txt"),
			alert("pip", "Analisis_Sentimen/requirements.txt"),
			alert("cargo", "rust/Cargo.lock"),
		])
		expect(lanes.map((l) => `${l.ecosystem} ${l.directory}`).sort()).toEqual([
			"cargo /rust",
			"pip /Analisis_Sentimen",
			"pip /Proyek_Klasifikasi_Gambar",
		])
	})

	test("heaviest first — the order an operator reads, and a stable diff", () => {
		const lanes = lanesForAlerts([
			alert("maven", "a/pom.xml"),
			...Array.from({ length: 5 }, () => alert("pip", "b/requirements.txt")),
			...Array.from({ length: 3 }, () => alert("npm", "package-lock.json")),
		])
		expect(lanes.map((l) => l.alerts)).toEqual([5, 3, 1])
	})

	test("an alert whose ecosystem cannot be determined is skipped, not guessed", () => {
		const lanes = lanesForAlerts([alert("", "weird.manifest")])
		expect(lanes).toEqual([])
	})
})

// ── Reading the existing config ──────────────────────────────────────────────

describe("lanes already declared by a config", () => {
	test("every lane in the real template is found", () => {
		// Pinned against the shipped file: if the template gains a lane and this
		// scanner stops seeing it, the sync would re-add a duplicate lane forever.
		const lanes = lanesInConfig(template)
		const seen = lanes.map((l) => `${l.ecosystem} ${l.directory}`)
		expect(seen).toContain("npm /")
		expect(seen).toContain("npm /apps/tauri")
		expect(seen).toContain("pip /")
		expect(seen).toContain("composer /")
		expect(seen).toContain("cargo /")
		expect(seen).toContain("maven /")
		expect(seen).toContain("github-actions /")
	})

	test("PROSE IS NOT A LANE — the template's comments name ecosystems", () => {
		// The template's header talks about "a Laravel app and a Rust service". A
		// scanner that reads comments would invent composer and cargo lanes that
		// are not there, and then never add the real ones.
		const lanes = lanesInConfig(
			[
				"# a Laravel app and a Rust service",
				"updates:",
				'  - package-ecosystem: "pip"',
				'    directory: "/x"',
			].join("\n"),
		)
		expect(lanes).toEqual([{ ecosystem: "pip", directory: "/x", alerts: 0 }])
	})

	test("a quoted directory is unquoted for comparison", () => {
		// Otherwise `/x` and `"/x"` never match and the lane is added every run.
		const lanes = lanesInConfig('  - package-ecosystem: "npm"\n    directory: "/x"')
		expect(lanes).toEqual([{ ecosystem: "npm", directory: "/x", alerts: 0 }])
	})
})

// ── The gap, and the fix ────────────────────────────────────────────────────

describe("missingLanes finds exactly the unreachable alerts", () => {
	test("a root npm manifest is already covered by the template", () => {
		const needs = lanesForAlerts([alert("npm", "package-lock.json")])
		expect(missingLanes(needs, lanesInConfig(template))).toEqual([])
	})

	test("a nested pip manifest is NOT covered — this is the 478-alert bug", () => {
		const needs = lanesForAlerts([alert("pip", "Proyek_Klasifikasi_Gambar/requirements.txt")])
		const missing = missingLanes(needs, lanesInConfig(template))
		expect(missing).toHaveLength(1)
		expect(missing[0]).toMatchObject({
			ecosystem: "pip",
			directory: "/Proyek_Klasifikasi_Gambar",
			alerts: 1,
		})
	})

	test("same ecosystem, different directory, is a DIFFERENT lane", () => {
		// The bug in one assertion: `pip /` does not cover `pip /sub`.
		const covered = lanesInConfig(template).some(
			(l) => l.ecosystem === "pip" && l.directory === "/Proyek_Klasifikasi_Gambar",
		)
		expect(covered).toBe(false)
	})
})

describe("withDerivedLanes renders a config Dependabot will accept", () => {
	test("nothing missing means the template is returned BYTE-IDENTICAL", () => {
		// A converged repo must produce no diff, or the nightly sync commits
		// every night forever.
		expect(withDerivedLanes(template, [])).toBe(template)
		expect(withDerivedLanes(template, lanesForAlerts([alert("npm", "package-lock.json")]))).toBe(
			template,
		)
	})

	test("a missing lane is appended, and the template body is preserved", () => {
		const out = withDerivedLanes(template, lanesForAlerts([alert("pip", "sub/requirements.txt")]))
		expect(out).toContain(template.trimEnd())
		expect(out).toContain('- package-ecosystem: "pip"')
		expect(out).toContain('directory: "/sub"')
	})

	test("a directory containing `&` is QUOTED", () => {
		// `modul7&8/modul8` is real. Unquoted, `&` starts a YAML anchor and
		// GitHub rejects the entire file — every lane in it, not just this one.
		const out = withDerivedLanes(
			template,
			lanesForAlerts([alert("maven", "modul7&8/modul8/pom.xml")]),
		)
		expect(out).toContain('directory: "/modul7&8/modul8"')
	})

	test("re-rendering is IDEMPOTENT — the derived lanes are then seen as present", () => {
		// Without this, each nightly run appends the same lane again and the
		// config grows without bound.
		const needs = lanesForAlerts([
			alert("pip", "a/requirements.txt"),
			alert("cargo", "rust/Cargo.lock"),
		])
		const once = withDerivedLanes(template, needs)
		expect(withDerivedLanes(once, needs)).toBe(once)
	})

	test("every derived lane carries a schedule, or Dependabot rejects it", () => {
		const out = withDerivedLanes(template, lanesForAlerts([alert("pip", "a/requirements.txt")]))
		const derived = out.slice(template.length)
		expect(derived).toContain("schedule:")
		expect(derived).toContain('interval: "weekly"')
	})

	test("the rendered config has a balanced number of lane entries", () => {
		// A cheap structural check: one `package-ecosystem` per `directory`. If a
		// render emitted a lane without a directory, the file would not parse.
		const out = withDerivedLanes(
			template,
			lanesForAlerts([
				alert("pip", "a/requirements.txt"),
				alert("maven", "b/pom.xml"),
				alert("npm", "c/package-lock.json"),
			]),
		)
		const ecos = out.match(/package-ecosystem:/g) ?? []
		const dirs = out.match(/^\s*directory:/gm) ?? []
		expect(ecos.length).toBe(dirs.length)
	})
})

// ── The report ───────────────────────────────────────────────────────────────

describe("summarizeVulns", () => {
	test("a clean repo says so", () => {
		expect(summarizeVulns("o/r", [])).toEqual(["✅ o/r: 0 open Dependabot security alerts"])
	})

	test("the summary is capped, so a 100-alert repo does not flood the log", () => {
		const alerts = Array.from({ length: 100 }, () => alert("npm", "package-lock.json"))
		const lines = summarizeVulns("o/r", alerts)
		expect(lines).toHaveLength(12) // header + 10 + "... and N more"
		expect(lines[lines.length - 1]).toBe("   ... and 90 more")
	})

	test("an alert with no patched version is reported as such, not as a version", () => {
		const a = alert("npm", "package-lock.json")
		a.security_vulnerability.first_patched_version = null
		expect(summarizeVulns("o/r", [a]).join("\n")).toContain("no patch")
	})
})

/**
 * `repoLanes` — coverage is a property of the repo's OWN config.
 *
 * The bug this pins: the audit compared alerts against the shared TEMPLATE, so
 * immediately after `--fix-vulns` wrote ten derived lanes, the audit still
 * reported "485 unreachable" — and would have forever. The template is not what
 * GitHub reads for a repo; `.github/dependabot.yml` is.
 */
describe("repoLanes reads the repo's config, not the template", () => {
	const repo = "owner/repo"
	const api = (status: number, body?: string) => ({
		async request() {
			if (status !== 200 || body === undefined) return { status, data: {} }
			return {
				status: 200,
				data: { content: Buffer.from(body, "utf8").toString("base64"), encoding: "base64" },
			}
		},
	})

	test("a derived lane in the repo's config COUNTS as covered", async () => {
		// The exact false negative that shipped.
		const config = [
			"version: 2",
			"updates:",
			'  - package-ecosystem: "pip"',
			'    directory: "/Proyek_Klasifikasi_Gambar"',
			"    schedule:",
			'      interval: "weekly"',
		].join("\n")
		const lanes = await repoLanes(api(200, config) as never, repo, "t", template)
		expect(
			lanes.some((l) => l.ecosystem === "pip" && l.directory === "/Proyek_Klasifikasi_Gambar"),
		).toBe(true)
		// And the alert on it is therefore reachable.
		const needs = lanesForAlerts([alert("pip", "Proyek_Klasifikasi_Gambar/requirements.txt")])
		expect(missingLanes(needs, lanes)).toEqual([])
	})

	test("a repo with no config falls back to the template — that is what the sync installs", async () => {
		const lanes = await repoLanes(api(404) as never, repo, "t", template)
		expect(lanes.map((l) => `${l.ecosystem} ${l.directory}`)).toContain("github-actions /")
	})

	test("an empty or undecodable file falls back rather than claiming zero lanes", async () => {
		// Zero lanes would report EVERY alert as unreachable, which is the same
		// class of wrong answer in the other direction.
		expect((await repoLanes(api(200, "   ") as never, repo, "t", template)).length).toBeGreaterThan(
			0,
		)
		expect(
			(
				await repoLanes(
					{ request: async () => ({ status: 200, data: {} }) } as never,
					repo,
					"t",
					template,
				)
			).length,
		).toBeGreaterThan(0)
	})
})

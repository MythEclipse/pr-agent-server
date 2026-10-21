// Dependency-bump facts: what actually changed, computed from the diff.
//
// WHY THIS EXISTS. A Dependabot bump got a review reading, in full:
//
//     Estimated effort: 1   Score: 95
//     No relevant tests
//     No key issues identified
//     No security concerns identified
//
// asepharyana/GMW#119, 3 files, +22/-16, 10 seconds. Nothing in that body is
// false, and nothing in it is useful either: the reader learns nothing about the
// two version bumps it is being asked to approve. Three separate causes combined
// (see markdown.ts and llm.ts for the other two), but the durable one is here —
// the model was handed a raw lockfile diff and asked for judgement, when the
// facts it needed were mechanically derivable and far more reliable than any
// model's reading of 500 lines of `pnpm-lock.yaml`.
//
// So: parse the version movement out of the manifests, attach whether the
// lockfile was updated consistently, and lead the review with that. It is
// computed, not generated, which means it is right even when the model is weak —
// and it stays right when the gateway substitutes one.

export interface DepBump {
	/** Package name as written in the manifest, or the `from -> to` pair for lockfile-only lines. */
	name: string
	from: string
	to: string
	/** Manifest this came from, when known (`package.json`, `Cargo.toml`, ...). */
	file: string
	/** `major` when the leading version component changed — the breaking-change risk. */
	severity: "major" | "minor" | "patch" | "unknown"
	/** True when the bump crosses a 0.x boundary, where semver guarantees do not apply. */
	zeroX: boolean
}

export interface DepBumpReport {
	isDependencyPr: boolean
	bumps: DepBump[]
	/** Manifest files touched. */
	manifests: string[]
	/** True when a lockfile is among the changed files. */
	lockfileChanged: boolean
	/** Manifests whose bump has no corresponding lockfile change. */
	manifestsWithoutLockfile: string[]
	/** Changed files that are neither manifest, lockfile, nor CI config. */
	otherFiles: string[]
}

const MANIFEST_PATTERNS: { re: RegExp; kind: "npm" | "toml" | "pip" | "gem" }[] = [
	{ re: /(^|\/)package\.json$/, kind: "npm" },
	{ re: /(^|\/)Cargo\.toml$/, kind: "toml" },
	{ re: /(^|\/)pyproject\.toml$/, kind: "toml" },
	{ re: /(^|\/)requirements[^/]*\.txt$/, kind: "pip" },
	{ re: /(^|\/)Gemfile$/, kind: "gem" },
]

const LOCKFILES = [
	"pnpm-lock.yaml",
	"package-lock.json",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"poetry.lock",
	"uv.lock",
	"Gemfile.lock",
	"composer.lock",
	"go.sum",
]

/** Files that never indicate a real behavioural change in a dependency PR. */
const NOISE = /(^|\/)(\.github\/|\.gitignore$|README|CHANGELOG|LICENSE)/i

export function isManifest(filename: string): boolean {
	return MANIFEST_PATTERNS.some((m) => m.re.test(filename))
}

export function isLockfile(filename: string): boolean {
	const base = filename.split("/").pop() ?? ""
	return LOCKFILES.includes(base)
}

/**
 * Split a semver-ish range into comparable numeric parts.
 *
 * Callers pass ranges (`^7.36.0`, `~=1.2`, `">=2.0 <3"`), so the leading digits
 * are what move; anything unparseable is left to `unknown` rather than guessed.
 */
function parseVersion(v: string): number[] | null {
	const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v)
	if (!m) return null
	return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

function classify(from: string, to: string): { severity: DepBump["severity"]; zeroX: boolean } {
	const a = parseVersion(from)
	const b = parseVersion(to)
	if (!a || !b) return { severity: "unknown", zeroX: false }
	// `zeroX` means the bump happens BELOW 1.0, where semver makes no API
	// stability promise — so a "minor" 0.9 -> 0.10 is in practice breaking.
	// Test it as "either side is 0.x", NOT as "the major component changed":
	// 0.9 -> 0.10 keeps major 0 on both sides, so a change-based test misses
	// exactly the case that matters most.
	const zeroX = a[0] === 0 || b[0] === 0
	if (a[0] !== b[0]) return { severity: "major", zeroX }
	if (a[1] !== b[1]) return { severity: "minor", zeroX }
	return { severity: "patch", zeroX }
}

/**
 * Pull `"name": "old"` -> `"name": "new"` movements out of a JSON manifest diff.
 *
 * Deliberately line-based on the `-`/`+` pair rather than JSON-parsing both
 * sides: the base file is not in the diff for a shallow clone, and a dependency
 * bump only ever rewrites a single-line version string, so pairing adjacent
 * removed/added lines is exact for this shape and needs no base tree.
 */
function npmBumps(patch: string, file: string): DepBump[] {
	const out: DepBump[] = []
	const lines = patch.split("\n")
	for (let i = 0; i < lines.length - 1; i++) {
		const minus = /^[-+]\s*"(@?[^"]+)"\s*:\s*"([^"]+)"/.exec(lines[i])
		if (!minus) continue
		const plus = /^[-+]\s*"(@?[^"]+)"\s*:\s*"([^"]+)"/.exec(lines[i + 1])
		if (!plus) continue
		const isMinus = lines[i].startsWith("-")
		const isPlus = lines[i + 1].startsWith("+")
		if (!isMinus || !isPlus) continue
		if (minus[1] !== plus[1]) continue
		if (minus[2] === plus[2]) continue
		const { severity, zeroX } = classify(minus[2], plus[2])
		out.push({ name: minus[1], from: minus[2], to: plus[2], file, severity, zeroX })
	}
	return out
}

/** `old = "1.2.3"` -> `new = "1.2.4"` in a TOML manifest (Cargo/pyproject). */
function tomlBumps(patch: string, file: string): DepBump[] {
	const out: DepBump[] = []
	const lines = patch.split("\n")
	for (let i = 0; i < lines.length - 1; i++) {
		const m = /^-\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(lines[i])
		if (!m) continue
		const p = /^\+\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(lines[i + 1])
		if (!p || p[1] !== m[1] || p[2] === m[2]) continue
		// Skip non-version keys that happen to be single-line strings.
		if (!/\d/.test(m[2]) || !/\d/.test(p[2])) continue
		const { severity, zeroX } = classify(m[2], p[2])
		out.push({ name: m[1], from: m[2], to: p[2], file, severity, zeroX })
	}
	return out
}

export interface DiffFileLike {
	filename: string
	patch: string
}

/**
 * Describe a PR's dependency movement.
 *
 * `isDependencyPr` is the load-bearing field: it decides whether the review is
 * led by these facts or by the model's prose. It is true when EVERY changed file
 * is a manifest, a lockfile, or CI noise — i.e. there is no application code for
 * a reviewer to reason about, which is exactly the case that used to produce an
 * empty-looking review.
 */
export function analyseDependencyPr(files: DiffFileLike[]): DepBumpReport {
	const manifests: string[] = []
	const bumps: DepBump[] = []
	const otherFiles: string[] = []
	let lockfileChanged = false

	for (const f of files) {
		if (isLockfile(f.filename)) {
			lockfileChanged = true
			continue
		}
		const pattern = MANIFEST_PATTERNS.find((m) => m.re.test(f.filename))
		if (pattern) {
			manifests.push(f.filename)
			bumps.push(
				...(pattern.kind === "npm"
					? npmBumps(f.patch, f.filename)
					: tomlBumps(f.patch, f.filename)),
			)
			continue
		}
		if (NOISE.test(f.filename)) continue
		otherFiles.push(f.filename)
	}

	const isDependencyPr = manifests.length > 0 && otherFiles.length === 0
	// A manifest bump with no lockfile update means the resolver was never run:
	// CI will either install a different tree than the manifest implies, or fail
	// on a frozen lockfile. Worth stating explicitly rather than hoping a model
	// notices it in a 500-line lockfile diff.
	const manifestsWithoutLockfile = manifests.length > 0 && !lockfileChanged ? manifests : []

	return {
		isDependencyPr,
		bumps,
		manifests,
		lockfileChanged,
		manifestsWithoutLockfile,
		otherFiles,
	}
}

/**
 * Render the computed facts as the review's leading section.
 *
 * Returned as markdown for the PR comment, and deliberately factual: version
 * movement, and the specific risk each bump carries. It does NOT claim a verdict
 * — whether a bump is safe depends on the dependency, and inventing "this looks
 * safe" is the failure this module exists to counter.
 */
export function renderDependencyFacts(report: DepBumpReport): string {
	if (!report.isDependencyPr) return ""
	const lines: string[] = []
	lines.push("### Dependency changes")
	lines.push("")

	if (report.bumps.length === 0) {
		lines.push(
			"No version movement could be parsed from the manifest diff — the lockfile changed but no manifest range did.",
		)
	} else {
		lines.push("| Package | From | To | Change |")
		lines.push("| --- | --- | --- | --- |")
		for (const b of report.bumps) {
			const flag = b.severity === "major" ? "**major**" : b.severity
			const zero = b.zeroX ? " (0.x — no semver guarantee)" : ""
			lines.push(`| \`${b.name}\` | \`${b.from}\` | \`${b.to}\` | ${flag}${zero} |`)
		}
	}

	lines.push("")
	if (report.manifestsWithoutLockfile.length > 0) {
		lines.push(
			`⚠️ **Lockfile not updated** for ${report.manifestsWithoutLockfile
				.map((m) => `\`${m}\``)
				.join(
					", ",
				)}. The manifest range moved without a lockfile change, so a frozen-lockfile install will either fail or resolve differently than intended.`,
		)
	} else if (report.lockfileChanged) {
		lines.push("Lockfile updated alongside the manifests.")
	}

	const majors = report.bumps.filter((b) => b.severity === "major")
	if (majors.length > 0) {
		lines.push("")
		lines.push(
			`**${majors.length} major bump(s)** — read the upstream changelog for ${majors
				.map((m) => `\`${m.name}\``)
				.join(", ")} before merging; a major version may remove APIs this repo uses.`,
		)
	}

	return lines.join("\n")
}

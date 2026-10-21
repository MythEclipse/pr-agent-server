// Dependency-PR facts: computed, not generated.
//
// Background: asepharyana/GMW#119 is a 3-file Dependabot bump (+22/-16) that got
// a review reading "No key issues identified" / score 95 / "No relevant tests" in
// 10 seconds. The reader could not tell from that comment WHICH packages moved or
// by how much — the one thing a dependency review exists to say.
//
// These facts are derived from the diff, so they hold no matter which model
// answers (or which model the gateway substitutes, see llm-served-model.test.ts).

import { describe, expect, test } from "vitest"
import {
	analyseDependencyPr,
	isLockfile,
	isManifest,
	renderDependencyFacts,
} from "../src/legacy/tools/dependency-facts.ts"

const pkg = (from: string, to: string, file = "apps/backend/package.json") => ({
	filename: file,
	patch: [
		"@@ -31,7 +31,7 @@",
		'     "hono": "^4.13.13",',
		`-    "openai": "${from}",`,
		`+    "openai": "${to}",`,
	].join("\n"),
})

const lock = {
	filename: "pnpm-lock.yaml",
	patch: "@@ -1 +1 @@\n-  openai: 7.36.0\n+  openai: 7.38.0\n",
}

describe("dependency-pr detection", () => {
	test("a manifest-only PR with a lockfile IS a dependency PR", () => {
		const r = analyseDependencyPr([pkg("^7.36.0", "^7.38.0"), lock])
		expect(r.isDependencyPr).toBe(true)
		expect(r.lockfileChanged).toBe(true)
	})

	test("a PR that also touches real code is NOT a dependency PR", () => {
		// This distinction decides whether the facts LEAD the review. Showing a
		// version table above a substantive code change would bury the part a
		// human must actually read.
		const r = analyseDependencyPr([
			pkg("^7.36.0", "^7.38.0"),
			lock,
			{ filename: "apps/api/src/main.ts", patch: "@@\n-const a = 1\n+const a = 2" },
		])
		expect(r.isDependencyPr).toBe(false)
		expect(r.otherFiles).toContain("apps/api/src/main.ts")
		expect(renderDependencyFacts(r)).toBe("")
	})

	test("CI config and README changes do not disqualify a dependency PR", () => {
		const r = analyseDependencyPr([
			pkg("^1.0.0", "^1.0.1"),
			{ filename: ".github/workflows/ci.yml", patch: "@@\n-  a: 1\n+  a: 2" },
			{ filename: "README.md", patch: "@@\n-x\n+y" },
		])
		expect(r.isDependencyPr).toBe(true)
	})

	test("a code-only PR yields no bumps at all", () => {
		const r = analyseDependencyPr([{ filename: "src/x.ts", patch: "@@\n-a\n+b" }])
		expect(r.isDependencyPr).toBe(false)
		expect(r.bumps).toEqual([])
	})
})

describe("version movement", () => {
	test("parses the real #119 pair exactly", () => {
		const r = analyseDependencyPr([
			pkg("^7.36.0", "^7.38.0", "apps/backend/package.json"),
			{
				filename: "apps/frontend/package.json",
				patch:
					'@@\n-    "@tanstack/react-query": "^5.104.3",\n+    "@tanstack/react-query": "^5.104.4",',
			},
			lock,
		])
		const byName = Object.fromEntries(r.bumps.map((b) => [b.name, b]))
		expect(byName.openai).toMatchObject({ from: "^7.36.0", to: "^7.38.0", severity: "minor" })
		expect(byName["@tanstack/react-query"]).toMatchObject({
			from: "^5.104.3",
			to: "^5.104.4",
			severity: "patch",
		})
	})

	test("classifies major vs minor vs patch by which component moved", () => {
		const sev = (from: string, to: string) =>
			analyseDependencyPr([pkg(from, to)]).bumps[0]?.severity
		expect(sev("^1.2.3", "^2.0.0")).toBe("major")
		expect(sev("^1.2.3", "^1.3.0")).toBe("minor")
		expect(sev("^1.2.3", "^1.2.4")).toBe("patch")
	})

	test("flags a 0.x crossing, where semver guarantees do not apply", () => {
		// 0.9 -> 0.10 is a BREAKING change by semver's rules but looks like a
		// minor bump to a naive reader.
		const r = analyseDependencyPr([pkg("^0.9.0", "^0.10.0")])
		expect(r.bumps[0]?.zeroX).toBe(true)
		expect(renderDependencyFacts(r)).toContain("0.x")
	})

	test("ignores a line that changed for a non-version reason", () => {
		// Reordering or reformatting must not be reported as a bump.
		const r = analyseDependencyPr([
			{ filename: "package.json", patch: '@@\n-    "a": "1.0.0",\n+    "b": "1.0.0",' },
		])
		expect(r.bumps).toEqual([])
	})

	test("ignores an unchanged value repeated across the pair", () => {
		const r = analyseDependencyPr([
			{ filename: "package.json", patch: '@@\n-    "a": "1.0.0",\n+    "a": "1.0.0",' },
		])
		expect(r.bumps).toEqual([])
	})
})

describe("lockfile consistency", () => {
	test("flags a manifest bump with NO lockfile change", () => {
		// A frozen-lockfile install then either fails or resolves differently
		// than the manifest claims — the single most useful thing to say about a
		// hand-edited bump.
		const r = analyseDependencyPr([pkg("^1.0.0", "^1.1.0")])
		expect(r.lockfileChanged).toBe(false)
		expect(r.manifestsWithoutLockfile).toContain("apps/backend/package.json")
		expect(renderDependencyFacts(r)).toContain("Lockfile not updated")
	})

	test("says the lockfile kept up when it did", () => {
		const r = analyseDependencyPr([pkg("^1.0.0", "^1.1.0"), lock])
		expect(renderDependencyFacts(r)).toContain("Lockfile updated")
	})

	test("recognises every lockfile this fleet uses", () => {
		for (const f of [
			"pnpm-lock.yaml",
			"package-lock.json",
			"yarn.lock",
			"bun.lock",
			"Cargo.lock",
		]) {
			expect(isLockfile(`some/dir/${f}`)).toBe(true)
		}
		expect(isLockfile("src/lock.ts")).toBe(false)
	})
})

describe("rendering", () => {
	test("a major bump names the packages to check upstream", () => {
		const r = analyseDependencyPr([pkg("^1.0.0", "^2.0.0"), lock])
		const md = renderDependencyFacts(r)
		expect(md).toContain("major bump")
		expect(md).toContain("`openai`")
	})

	test("claiming no verdict: it never says a bump is safe", () => {
		// Safety depends on the dependency, which the diff cannot establish.
		// Inventing that verdict is the exact failure this module counters.
		const r = analyseDependencyPr([pkg("^1.0.0", "^1.2.0"), lock])
		const md = renderDependencyFacts(r).toLowerCase()
		expect(md).not.toContain("safe to merge")
		expect(md).not.toContain("no issues")
	})

	test("recognises the manifests of the other ecosystems here", () => {
		expect(isManifest("Cargo.toml")).toBe(true)
		expect(isManifest("pyproject.toml")).toBe(true)
		expect(isManifest("apps/api/package.json")).toBe(true)
		expect(isManifest("src/app.ts")).toBe(false)
	})
})

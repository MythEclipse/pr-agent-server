// THE INCIDENT THIS GUARDS: hub#61 + pr-agent-server#27.
//
// Both were a Dependabot bump of `@moonrepo/cli` 2.6.2 → 2.6.3. That release
// declares `optionalDependencies` on `@moonrepo/core-<platform>@2.6.3`, and
// those platform packages were never published — the registry goes 2.6.2 →
// 2.6.4. Verified directly:
//
//   npm view @moonrepo/core-linux-x64-gnu@2.6.3 version   # 404
//   pnpm install --frozen-lockfile && pnpm exec moon --version
//   # Error: Cannot find module '@moonrepo/core-linux-x64-gnu/package.json'
//
// No edit to either branch could make CI green, but the worker's prompt says
// "Make the failing job pass. Do not work around it", so the agent burned its
// 100 turns / 1800s and was then pinned `Permanently skipped`.
//
// The guard reads the registry BEFORE any agent run and refuses on positive
// evidence only. Every test below is a boundary of "positive evidence": a
// registry blip, an out-of-scope package, or a group bump must all PASS, because
// a false accusation blocks a good PR while a miss only costs one agent run.
import { describe, expect, test } from "vitest"

import {
	badBumpComment,
	findBadBump,
	isPlatformWrapperSet,
	parseSingleBump,
	type RegistryFetch,
	type RegistryPackument,
} from "../src/pr/bump-guard.ts"

/** A registry where `pkg@ver` exists unless listed in `absent`. */
function registry(docs: Record<string, RegistryPackument>, absent: string[] = []): RegistryFetch {
	return async (pkg, version) => {
		const key = `${pkg}@${version}`
		if (absent.includes(key)) return { missing: true }
		return docs[key] ?? null
	}
}

/** The real 2.6.3 shape: the parent exists, its platform members do not. */
const MOON_CLI_263: RegistryPackument = {
	optionalDependencies: {
		"@moonrepo/core-linux-arm64-gnu": "2.6.3",
		"@moonrepo/core-linux-arm64-musl": "2.6.3",
		"@moonrepo/core-linux-x64-gnu": "2.6.3",
		"@moonrepo/core-linux-x64-musl": "2.6.3",
		"@moonrepo/core-macos-arm64": "2.6.3",
		"@moonrepo/core-macos-x64": "2.6.3",
		"@moonrepo/core-windows-x64-msvc": "2.6.3",
	},
}

const TITLE_263 = "chore(deps-dev): bump @moonrepo/cli from 2.6.2 to 2.6.3"

describe("parseSingleBump", () => {
	test("reads a deps and a deps-dev single-package bump", () => {
		expect(parseSingleBump(TITLE_263)).toEqual({
			pkg: "@moonrepo/cli",
			from: "2.6.2",
			to: "2.6.3",
		})
		expect(parseSingleBump("chore(deps): bump vite from 8.3.4 to 8.3.5")).toEqual({
			pkg: "vite",
			from: "8.3.4",
			to: "8.3.5",
		})
	})

	test("a GROUP bump names no single package and is out of scope", () => {
		// The real title of pr-agent-server#27 is a group bump; the guard must not
		// pretend it can verify seven packages in one tick.
		expect(
			parseSingleBump(
				"chore(deps-dev): bump the development-dependencies group across 1 directory with 7 updates",
			),
		).toBeNull()
	})

	test("a re-run prefix is not judged as the current title", () => {
		expect(parseSingleBump(`Re-run: ${TITLE_263}`)).toBeNull()
	})
})

describe("isPlatformWrapperSet", () => {
	test("a set where every name carries a platform word qualifies", () => {
		expect(isPlatformWrapperSet(MOON_CLI_263.optionalDependencies)).toBe(true)
		expect(
			isPlatformWrapperSet({
				"@biomejs/cli-linux-x64": "2.6.2",
				"@biomejs/cli-darwin-arm64": "2.6.2",
			}),
		).toBe(true)
	})

	test("an ordinary optional dependency set does NOT qualify", () => {
		// This is the case that must never be accused: a package that merely
		// suggests an extra, with no platform binaries involved.
		expect(isPlatformWrapperSet({ fsevents: "^2.3.3" })).toBe(false)
		expect(isPlatformWrapperSet({ "some-optional-helper": "1.0.0" })).toBe(false)
	})

	test("empty or absent is not a wrapper set", () => {
		expect(isPlatformWrapperSet({})).toBe(false)
		expect(isPlatformWrapperSet(undefined)).toBe(false)
	})
})

describe("findBadBump — the @moonrepo/cli@2.6.3 shape", () => {
	test("a bump whose platform binaries were never published is refused", async () => {
		const absent = Object.keys(MOON_CLI_263.optionalDependencies ?? {}).map((m) => `${m}@2.6.3`)
		const bad = await findBadBump(
			TITLE_263,
			registry({ "@moonrepo/cli@2.6.3": MOON_CLI_263 }, absent),
		)

		expect(bad).not.toBeNull()
		expect(bad?.pkg).toBe("@moonrepo/cli")
		expect(bad?.to).toBe("2.6.3")
		// The reason must name a member, so the claim is checkable with one
		// `npm view` rather than being an assertion.
		expect(bad?.reason).toContain("@moonrepo/core-linux-x64-gnu@2.6.3")
		expect(bad?.reason).toContain("never published")
	})

	test("the comment names the evidence and does NOT claim the PR was closed", async () => {
		const absent = Object.keys(MOON_CLI_263.optionalDependencies ?? {}).map((m) => `${m}@2.6.3`)
		const bad = await findBadBump(
			TITLE_263,
			registry({ "@moonrepo/cli@2.6.3": MOON_CLI_263 }, absent),
		)
		const body = badBumpComment(bad!)

		expect(body).toContain("unshippable dependency bump")
		expect(body).toContain("npm view @moonrepo/cli@2.6.3 optionalDependencies")
		// Leaving it open is the policy: closing a Dependabot bump is a silent loss.
		expect(body).toContain("left open on purpose")
		expect(body).toContain("AI fix was **not** run")
	})
})

describe("findBadBump — every uncertainty is a PASS", () => {
	test("a registry blip (null) is not evidence", async () => {
		// "Could not tell" must never be reported as "missing": that would block a
		// good bump on a rate limit.
		const bad = await findBadBump(TITLE_263, async () => null)
		expect(bad).toBeNull()
	})

	test("a member that could not be read is not missing", async () => {
		const bad = await findBadBump(TITLE_263, async (pkg) =>
			pkg === "@moonrepo/cli" ? MOON_CLI_263 : null,
		)
		expect(bad).toBeNull()
	})

	test("every platform member published is a pass", async () => {
		const docs: Record<string, RegistryPackument> = {
			"@moonrepo/cli@2.6.4": MOON_CLI_263,
		}
		for (const m of Object.keys(MOON_CLI_263.optionalDependencies ?? {})) {
			docs[`${m}@2.6.4`] = {}
		}
		const bad = await findBadBump(
			"chore(deps-dev): bump @moonrepo/cli from 2.6.3 to 2.6.4",
			registry(docs),
		)
		expect(bad).toBeNull()
	})

	test("a pure-JS package is out of scope even when the registry cannot answer", async () => {
		const bad = await findBadBump("chore(deps): bump vite from 8.3.4 to 8.3.5", async () => ({
			dependencies: { esbuild: "^0.28.0" },
		}))
		expect(bad).toBeNull()
	})

	test("a group bump is never refused", async () => {
		const bad = await findBadBump(
			"chore(deps-dev): bump the development-dependencies group across 1 directory with 7 updates",
			async () => ({ missing: true }),
		)
		expect(bad).toBeNull()
	})

	test("a member pinned to a DIFFERENT version is not this bump's problem", async () => {
		// The parent may declare `core-x: 2.6.2` while the parent itself is 2.6.3;
		// that is a different (pre-existing) shape, not this release's breakage.
		const bad = await findBadBump(
			TITLE_263,
			registry({
				"@moonrepo/cli@2.6.3": {
					optionalDependencies: { "@moonrepo/core-linux-x64-gnu": "2.6.2" },
				},
			}),
		)
		expect(bad).toBeNull()
	})
})

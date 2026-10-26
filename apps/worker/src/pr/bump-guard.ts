/**
 * Refuse a dependency bump that CANNOT work, before paying for an agent run.
 *
 * THE INCIDENT. `hub#61` and `pr-agent-server#27` were both a Dependabot bump of
 * `@moonrepo/cli` 2.6.2 → 2.6.3. That release shipped with
 * `optionalDependencies` naming `@moonrepo/core-<platform>@2.6.3`, and those
 * platform packages were NEVER PUBLISHED — the registry goes 2.6.2 → 2.6.4.
 * Verified directly:
 *
 *   npm view @moonrepo/core-linux-x64-gnu@2.6.3 version   # 404
 *   pnpm install --frozen-lockfile && pnpm exec moon --version
 *   # Error: Cannot find module '@moonrepo/core-linux-x64-gnu/package.json'
 *
 * That is exactly what CI reported (`verify — failure`, exit 1), and there is no
 * edit to the branch that can fix it. But the worker's prompt says "Make the
 * failing job pass. Do not work around it", so the agent tried, ran out of its
 * 100 turns / 1800s, and was then pinned `Permanently skipped` — the worst of
 * both outcomes: maximum cost, zero progress, and a PR nobody can release.
 *
 * WHAT THIS DOES. For a Dependabot bump of a single package, ask the registry
 * whether the new version's platform-specific optional dependencies actually
 * exist. When they do not, the bump is unshippable by construction: report it,
 * comment the evidence on the PR, and do not run the agent.
 *
 * DELIBERATELY NARROW, in four ways:
 *
 *   - It only looks at bumps whose package declares PLATFORM-KEYED
 *     `optionalDependencies` (a `cpu`/`os`/`libc` shape is the giveaway: those
 *     are the native-binary wrappers). A bump of a pure-JS package is never
 *     touched, because there is nothing to check and a false accusation on a
 *     normal PR is far worse than a missed catch.
 *   - It only fails on a DEFINITE 404. Every other answer — a timeout, a 5xx, a
 *     rate limit, an unreadable body — is "we could not tell" and therefore a
 *     pass. This must never be the reason a good PR is blocked.
 *   - It runs at most once per head SHA per PR, gated by the caller's state, so
 *     a bumped package cannot turn every tick into a registry sweep.
 *   - It does not CLOSE the PR. Closing a Dependabot PR is a silent loss (see
 *     the policy note in `gates.ts`): the update vanishes with no trace. It
 *     comments the evidence and leaves the decision to a human.
 *
 * The registry call is injected, so the whole thing is testable without a
 * socket and the worker keeps its "no module-scope effects" rule.
 */

import type { GhClient } from "./scan.ts"

/**
 * Dependabot's title form, for the two shapes this worker sees:
 *
 *   chore(deps): bump @moonrepo/cli from 2.6.2 to 2.6.3
 *   chore(deps-dev): bump typescript from 5.0.0 to 6.0.0
 *
 * Anchored at the start for the same reason as `pins.ts`: a re-run prefix must
 * not be judged as the current title. `GROUP` titles ("bump the development
 * group across 1 directory with 7 updates") name no single package and
 * therefore return null — a group bump is out of scope here, because verifying
 * every member would be a registry sweep per tick.
 */
const SINGLE_BUMP = /^chore\(deps(?:-dev)?\): bump ([^\s]+) from ([0-9][^\s]*) to ([0-9][^\s]*)/

/** The three fields of a registry document this guard needs. */
export type RegistryPackument = {
	/** `versions[ver].optionalDependencies` — the platform-binary wrappers. */
	optionalDependencies?: Record<string, string>
	/** `versions[ver].dependencies`. */
	dependencies?: Record<string, string>
	/**
	 * The "confirmed absent" sentinel. A 404 on the version-specific endpoint is
	 * the ONLY answer that may produce a refusal, and it has to be distinguishable
	 * from `null` ("could not tell"), so it travels as a field rather than as a
	 * null return.
	 */
	missing?: boolean
}

/** The injected registry read. Returns null when the answer is not a 200. */
export type RegistryFetch = (pkg: string, version: string) => Promise<RegistryPackument | null>

/** A bump that cannot work, with the reason to put in the report and comment. */
export type BadBump = { pkg: string; from: string; to: string; reason: string }

/** Parse a single-package Dependabot bump title, or null for anything else. */
export function parseSingleBump(title: string): { pkg: string; from: string; to: string } | null {
	const m = SINGLE_BUMP.exec(String(title))
	if (!m) return null
	return { pkg: m[1], from: m[2], to: m[3] }
}

/**
 * Is this dependency list a set of PLATFORM BINARY wrappers?
 *
 * The check is on the NAMES, not on a hardcoded package list, because the same
 * shape appears across the ecosystem (`@moonrepo/core-*`, `@biomejs/cli-*`,
 * `@esbuild/*`, `@rollup/rollup-*`, `@swc/core-*`). Every one of them is an
 * optional dependency whose name carries the platform, and every one of them
 * breaks its parent when a platform member is missing from the registry.
 *
 * A single non-platform optional dependency (an ordinary "you may also want
 * this" package) must NOT trigger the guard, so the requirement is that EVERY
 * entry carries a platform word — not merely one.
 */
const PLATFORM_WORD =
	/(linux|darwin|macos|win32|windows|freebsd|android|musl|gnu|arm64|x64|ia32|ppc64|s390x|riscv64)/i

export function isPlatformWrapperSet(deps: Record<string, string> | undefined): boolean {
	const names = Object.keys(deps ?? {})
	if (names.length === 0) return false
	return names.every((n) => PLATFORM_WORD.test(n))
}

/**
 * Decide whether `pkg@version` is a bump that cannot install.
 *
 * Returns null when it is fine, unreadable, or out of scope — the guard only
 * ever REFUSES on positive evidence, so every uncertainty is a pass.
 *
 * `missingFromLockfile` is not used: the authoritative question is what the
 * registry has, and the lockfile Dependabot wrote is itself derived from a
 * registry read that evidently succeeded for the parent while failing for the
 * platform members.
 */
export async function findBadBump(
	title: string,
	fetchRegistry: RegistryFetch,
): Promise<BadBump | null> {
	const bump = parseSingleBump(title)
	if (!bump) return null

	const packument = await fetchRegistry(bump.pkg, bump.to)
	if (!packument) return null // could not tell — pass

	const optional = packument.optionalDependencies
	if (!isPlatformWrapperSet(optional)) return null // out of scope — pass

	// The parent's optional deps name the platform members. Check the ones whose
	// declared version matches the bumped version: those are the members this
	// exact release is supposed to ship, and a 404 on one of them is the
	// `@moonrepo/cli@2.6.3` failure precisely.
	const expected = Object.entries(optional ?? {}).filter(([, v]) => v === bump.to)
	if (expected.length === 0) return null // no pinned members — pass

	const missing: string[] = []
	for (const [member] of expected) {
		const memberPackument = await fetchRegistry(member, bump.to)
		// `null` is "could not tell", NOT "missing". Only the explicit sentinel may
		// produce a refusal, so a registry blip can never block a good bump.
		if (memberPackument?.missing === true) missing.push(member)
	}
	if (missing.length === 0) return null

	return {
		pkg: bump.pkg,
		from: bump.from,
		to: bump.to,
		reason:
			`${bump.pkg}@${bump.to} declares optionalDependencies on ` +
			// Each member carries its own version, because that is how the claim is
			// re-checked: `npm view <member>@<ver>`. Joining bare names and appending
			// one version at the end would read as if only the LAST member were
			// pinned, which is the opposite of what was verified.
			`${missing.map((m) => `${m}@${bump.to}`).join(", ")}, which ` +
			`${missing.length === 1 ? "was" : "were"} never published. ` +
			`The package cannot install, so this bump cannot go green — no code change fixes it.`,
	}
}

/**
 * The comment left on the PR. Written as a record for a human, not an
 * instruction to the bot, and it names the exact evidence so the claim can be
 * re-checked with one `npm view`.
 */
export function badBumpComment(bad: BadBump): string {
	return (
		`⛔ Auto-detected by PR Queue Worker — **unshippable dependency bump**.\n\n` +
		`${bad.reason}\n\n` +
		`Evidence: \`npm view ${bad.pkg}@${bad.to} optionalDependencies\` names ` +
		`platform packages that return 404 from the registry.\n\n` +
		`This PR is left open on purpose — closing a Dependabot bump is a silent ` +
		`loss. To fix it, bump \`${bad.pkg}\` to a release whose platform ` +
		`packages were actually published (or pin it back to \`${bad.from}\`). ` +
		`The AI fix was **not** run: there is nothing in this branch for it to change.`
	)
}

/**
 * A `RegistryFetch` backed by the real npm registry, over the injected `fetch`.
 *
 * A 404 returns the `{ missing: true }` sentinel rather than null, because the
 * caller must be able to tell "confirmed absent" from "could not tell". Every
 * other failure — a network error, a 5xx, a rate limit, a body that is not
 * JSON — is null, i.e. "pass".
 */
export function registryFetchFrom(
	fetchImpl: (url: string) => Promise<{ status: number; text(): Promise<string> }>,
	registry = "https://registry.npmjs.org",
): RegistryFetch {
	return async (pkg: string, version: string) => {
		try {
			// The version-specific endpoint is what makes a 404 meaningful: the
			// packument for the PACKAGE exists, and the 404 is about this version.
			const url = `${registry}/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}`
			const res = await fetchImpl(url)
			if (res.status === 404) return { missing: true } as RegistryPackument
			if (res.status !== 200) return null
			const doc = JSON.parse(await res.text()) as RegistryPackument
			return doc !== null && typeof doc === "object" ? doc : null
		} catch {
			return null
		}
	}
}

/**
 * Post the evidence as a PR comment, best-effort.
 *
 * Returns the HTTP status so the caller can report a failed post, but never
 * throws: a comment that did not land must not stop the tick.
 */
export async function commentBadBump(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
	bad: BadBump,
): Promise<number> {
	try {
		const { status } = await api.request("POST", `/repos/${repo}/issues/${pr}/comments`, {
			token,
			json: { body: badBumpComment(bad) },
		})
		return status
	} catch {
		return 0
	}
}

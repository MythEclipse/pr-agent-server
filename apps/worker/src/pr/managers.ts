/**
 * WHICH toolchain a repo resolves its lockfile with, and how that toolchain is
 * made to re-resolve it.
 *
 * THE PROBLEM THIS EXISTS FOR. Dependabot bumps the manifest and CI dies at the
 * frozen-lockfile install, because the lockfile was never regenerated. The
 * worker used to repair that for exactly two toolchains — bun and uv — chosen by
 * a hard-coded `bun.lock` probe, so every npm / pnpm / yarn repo fell straight
 * through to the AI agent (or to no fix at all) on a PR whose only defect was a
 * stale lockfile. The fix is data, not a fifth `if`: one row per toolchain, and
 * the deterministic repair runs for whichever rows the repo actually has.
 *
 * DETECTION IS BY LOCKFILE, NEVER BY GUESS. A repo can hold more than one
 * lockfile (a pnpm workspace with a uv sub-project, a bun repo whose CI still
 * runs npm), so the probes return EVERY match and the caller repairs each. The
 * alternative — picking one — regenerates a lockfile CI never reads and leaves
 * the PR red with a green-looking report.
 *
 * THE LOCK BUDGET IS SHORT ON PURPOSE. `install` is the step that can hang on a
 * registry, and it runs inside a tick that holds the worker lock. The frozen
 * install (the diagnosis) gets the longer budget because a cold resolve of a
 * large graph is legitimately slow; a non-frozen re-resolve that has run this
 * long is stuck, not working.
 */
import type { GhClient } from "./scan.ts"

/** One toolchain's repair recipe: what to probe for, and how to re-resolve. */
export type PackageManager = {
	/** Stable id, used in workdir names and the report. */
	readonly id: string
	/** Human/tool name for the report line — `pnpm`, `cargo`, … */
	readonly label: string
	/**
	 * Lockfile paths (repo-relative, exact tail match) whose presence means this
	 * toolchain owns the resolution. Root and workspace locations both count.
	 */
	readonly lockfiles: readonly string[]
	/**
	 * The install CI runs with the lockfile frozen — the DIAGNOSIS. A success
	 * here means the lockfile was never the problem, so nothing is pushed.
	 */
	readonly frozenInstall: readonly string[]
	/**
	 * The install that re-resolves and writes the lockfile. Must be the same
	 * tool as `frozenInstall`, so the diff it produces is the one CI compares.
	 */
	readonly syncInstall: readonly string[]
	/**
	 * Files the sync install is allowed to leave modified. Anything else means
	 * the diagnosis was wrong and the change must not ride along on the PR.
	 */
	readonly managed: readonly string[]
	/** The commit subject used when this repair pushes. */
	readonly commitMessage: string
	/** Seconds `frozenInstall` may take. */
	readonly frozenTimeoutSec: number
	/** Seconds `syncInstall` may take. */
	readonly syncTimeoutSec: number
}

/**
 * Every toolchain the worker can repair, in the order they are tried.
 *
 * `bun` keeps the budgets the original bun-only flow used (120 / 180) and the
 * same two commands, so a Bun repo's behaviour is unchanged. The rows that never
 * existed before use the frozen/re-resolve pair each tool documents itself:
 *
 *   npm       `npm ci`                          `npm install`
 *   pnpm      `pnpm install --frozen-lockfile`  `pnpm install --no-frozen-lockfile`
 *   yarn      `yarn install --frozen-lockfile`  `yarn install`
 *   uv        `uv sync --locked`                `uv lock`
 *   go        `go mod tidy -diff`               `go mod tidy`
 *   composer  `composer validate`               `composer update --lock`
 *   bundler   `bundle install --frozen`         `bundle lock`
 *
 * A TOOLCHAIN IS ONLY LISTED WHEN ITS RE-RESOLVE IS NARROW. `cargo` is absent
 * on purpose: the only way to make Cargo re-resolve is `cargo update`, which
 * moves every dependency in the graph — thousands of lines a reviewer never
 * asked for, on a PR that was supposed to change one version. A Cargo bump that
 * does not resolve is a real conflict and belongs to the agent, which can read
 * the error and edit the manifest.
 *
 * YARN IS v1 AND v2+ AT ONCE. `--frozen-lockfile` is the v1 spelling and
 * `--immutable` is the Berry one; each major treats the other's flag as a
 * warning, not an error, but a repo pinning Berry in `packageManager` will not
 * have v1's flag honoured. The row uses the v1 pair, which is what the vast
 * majority of `yarn.lock` files in the fleet resolve with, and the frozen probe
 * and the re-resolve share a tool so they cannot disagree about state.
 */
export const PACKAGE_MANAGERS: readonly PackageManager[] = [
	{
		id: "bun",
		label: "bun",
		lockfiles: ["bun.lock", "bun.lockb"],
		frozenInstall: ["bun", "install", "--frozen-lockfile"],
		syncInstall: ["bun", "install"],
		managed: ["bun.lock", "bun.lockb"],
		commitMessage: "chore: sync bun.lock after dependabot bump",
		frozenTimeoutSec: 120,
		syncTimeoutSec: 180,
	},
	{
		id: "pnpm",
		label: "pnpm",
		lockfiles: ["pnpm-lock.yaml"],
		// `--frozen-lockfile` rather than `--lockfile-only`: the question is
		// whether the lockfile CI reads matches the manifest, and that is answered
		// by the same install CI runs — not by a dry re-resolve that can pass
		// while the real one fails on a build script.
		frozenInstall: ["pnpm", "install", "--frozen-lockfile"],
		syncInstall: ["pnpm", "install", "--no-frozen-lockfile"],
		managed: ["pnpm-lock.yaml"],
		commitMessage: "chore: sync pnpm-lock.yaml after dependabot bump",
		frozenTimeoutSec: 300,
		syncTimeoutSec: 180,
	},
	{
		id: "npm",
		label: "npm",
		lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
		// `npm ci` is npm's own frozen install, and it is the one that fails on a
		// manifest/lockfile mismatch (it deletes node_modules and installs the
		// lockfile verbatim). `npm install` is the re-resolve.
		frozenInstall: ["npm", "ci"],
		syncInstall: ["npm", "install"],
		managed: ["package-lock.json", "npm-shrinkwrap.json"],
		commitMessage: "chore: sync package-lock.json after dependabot bump",
		frozenTimeoutSec: 300,
		syncTimeoutSec: 180,
	},
	{
		id: "yarn",
		label: "yarn",
		lockfiles: ["yarn.lock"],
		// Berry rejects `--frozen-lockfile`; v1 ignores `--immutable` with a
		// warning and installs. Running BOTH spellings in one command would fail on
		// whichever major is not installed, so the frozen probe stays v1 and the
		// sync uses the same flags — see `frozenInstallOf` in the tests, which
		// asserts the two agree.
		frozenInstall: ["yarn", "install", "--frozen-lockfile"],
		syncInstall: ["yarn", "install"],
		managed: ["yarn.lock"],
		commitMessage: "chore: sync yarn.lock after dependabot bump",
		frozenTimeoutSec: 300,
		syncTimeoutSec: 180,
	},
	{
		id: "uv",
		label: "uv",
		lockfiles: ["uv.lock"],
		// The original uv row. `uv lock` is the re-resolve (it writes uv.lock and
		// touches nothing else), and `uv sync --locked` is the frozen probe.
		frozenInstall: ["uv", "sync", "--locked"],
		syncInstall: ["uv", "lock"],
		managed: ["uv.lock"],
		commitMessage: "chore: refresh uv.lock after dependabot bump [skip ci]",
		frozenTimeoutSec: 300,
		syncTimeoutSec: 180,
	},
	{
		id: "go",
		label: "go",
		lockfiles: ["go.sum"],
		// `go mod verify` needs no network and does not compare against a lock, so
		// the frozen probe is `go mod tidy -diff`: it exits non-zero exactly when
		// go.mod/go.sum are not what go would write, which is the CI failure.
		frozenInstall: ["go", "mod", "tidy", "-diff"],
		syncInstall: ["go", "mod", "tidy"],
		managed: ["go.sum", "go.mod"],
		commitMessage: "chore: sync go.sum after dependabot bump",
		frozenTimeoutSec: 120,
		syncTimeoutSec: 180,
	},
	{
		id: "composer",
		label: "composer",
		lockfiles: ["composer.lock"],
		// Composer has no frozen install flag; `composer validate --no-check-all`
		// is the mismatch probe, and `composer update --lock` re-resolves ONLY the
		// lock (never the manifests' versions).
		frozenInstall: ["composer", "validate", "--no-check-all", "--no-check-publish"],
		syncInstall: ["composer", "update", "--lock"],
		managed: ["composer.lock"],
		commitMessage: "chore: sync composer.lock after dependabot bump",
		frozenTimeoutSec: 120,
		syncTimeoutSec: 240,
	},
	{
		id: "bundler",
		label: "bundler",
		lockfiles: ["Gemfile.lock"],
		// `bundle install --frozen` is bundler's frozen mode (it fails on a
		// Gemfile/Gemfile.lock mismatch), and `bundle lock` re-resolves without
		// installing anything.
		frozenInstall: ["bundle", "install", "--frozen"],
		syncInstall: ["bundle", "lock"],
		managed: ["Gemfile.lock"],
		commitMessage: "chore: sync Gemfile.lock after dependabot bump",
		frozenTimeoutSec: 180,
		syncTimeoutSec: 180,
	},
]

/** The row with this id, or `undefined` — for callers that name one toolchain. */
export const packageManagerById = (id: string): PackageManager | undefined =>
	PACKAGE_MANAGERS.find((pm) => pm.id === id)

/**
 * True when `path` names one of `lockfiles`, anywhere in the tree.
 *
 * A SUFFIX MATCH ON THE PATH SEGMENT, not a substring of the whole string: the
 * bun probe this replaces used `path.includes("bun.lock")`, which also matched
 * `bun.lock.bak` and `docs/bun.lock.md`. A lockfile only counts when the last
 * segment matches exactly.
 */
export const pathIsLockfile = (path: string, lockfiles: readonly string[]): boolean => {
	const segments = path.split("/")
	const name = segments[segments.length - 1] ?? ""
	return lockfiles.includes(name)
}

/**
 * Every toolchain whose lockfile exists in the repo tree at `sha`.
 *
 * Failure means "none": a non-200, a malformed body, or a thrown request all
 * return an empty list, because this predicate only chooses WHICH repair to try
 * and a throw here would abort the whole tick. An empty result is a legitimate
 * answer — a repo with no recognised lockfile gets no deterministic repair and
 * the PR moves on to the agent.
 */
export async function detectPackageManagers(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
): Promise<PackageManager[]> {
	const paths = await lockfilePaths(api, token, repo, sha)
	return PACKAGE_MANAGERS.filter((pm) => paths.some((path) => pathIsLockfile(path, pm.lockfiles)))
}

/**
 * Every path in the repo tree at `sha`, or `[]` when the tree cannot be read.
 *
 * One tree call answers every toolchain probe, so a repo with four lockfiles
 * costs one request rather than four.
 */
async function lockfilePaths(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
): Promise<string[]> {
	try {
		const { status, data } = await api.request(
			"GET",
			`/repos/${repo}/git/trees/${sha}?recursive=1`,
			{ token },
		)
		if (status !== 200 || !Array.isArray(data?.tree)) return []
		return (data.tree as { path?: unknown }[])
			.map((item) => (typeof item?.path === "string" ? item.path : ""))
			.filter((path) => path.length > 0)
	} catch {
		// Swallowed on purpose: this only picks a repair, and an unreadable tree
		// must degrade to "no deterministic repair", never to a failed tick.
		return []
	}
}

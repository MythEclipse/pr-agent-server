/**
 * The lockfile re-resolve-and-push flow for trivial (dependabot) PRs — ONE flow,
 * parameterised by a `PackageManager` row from `./managers`.
 *
 * WHAT THIS FILE USED TO BE. Two near-identical functions, `fixUvLock` and
 * `fixBunLock`, ported line-by-line from `scripts/pr-queue-worker.py` 627-791.
 * They differed in five places — clone depth, merge flags, `git add`, commit
 * message, "nothing to commit" tolerance — and every difference is a fact about
 * a TOOLCHAIN, not about the flow. Adding npm, pnpm, yarn, go, composer and
 * bundler as five more copies would have been seven versions of a 60-line
 * function kept in step by hand, so the flow lives once and the five differences
 * are fields on the row.
 *
 * THE PYTHON'S PARITY CONTRACT IS KEPT, NOT REWRITTEN. For the bun and uv rows
 * the summary strings, the TAIL-then-HEAD truncation order
 * (`stderr[-300:]` then `[:100]`), the per-site widths, the argv and the workdir
 * names are byte-identical to what shipped, because a summary string is read on
 * an ops channel and several are contracts. `SHAPES` carries the two original
 * toolchains' asymmetries; every other row takes the stricter default.
 */

import { tail } from "../git.ts"
import { clonePr, head, type LockfixDeps, reportable, TMP_BASE } from "./lockfix.ts"
import { type PackageManager, packageManagerById } from "./managers.ts"

// ── Timeout budgets ─────────────────────────────────────────────────────────
// One per Python `subprocess.run(..., timeout=N)`, each with its line cited.
// None of them is the same number; a shared default would be a guess, and a
// guess here changes how long a cron tick can hang.
const FETCH_TIMEOUT_SEC = 30 // 659-660, 747
const MERGE_TIMEOUT_SEC = 30 // 661-662, 748-749
const ABORT_TIMEOUT_SEC = 15 // 665, 751
const DIFF_TIMEOUT_SEC = 15 // 678, 769
const ADD_TIMEOUT_SEC = 15 // 691, 776
const COMMIT_TIMEOUT_SEC = 30 // 692-695, 777-780
const PUSH_TIMEOUT_SEC = 60 // 700-701, 785-786
/** Python `clone ... "--depth", "5"` (line 648) — the uv lockfix clone only. */
const LOCKFIX_DEPTH = 5

// ── Summary slice widths, one per Python site ───────────────────────────────
const STDERR_TAIL = 300 // `stderr[-300:]` — 673, 764
const DETAIL = 100 // `[:100]` of that tail — 675, 766, 698, 706, 783, 791
const CLONE_DETAIL = 200 // 741 — the bun clone site only
const FILE_CAP = 3 // `changed[:3]` — 689, 774

/** Python `[f.strip() for f in stdout.split("\n") if f.strip()]` (679, 770). */
function changedPaths(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((f) => f.trim())
		.filter((f) => f.length > 0)
}

/** The last path segment, so a workspace lockfile still counts as itself. */
const basename = (path: string): string => path.split("/").pop() ?? ""

/** How one toolchain's clone is merged, staged and reported. */
type FlowShape = {
	/** `null` omits `--depth` entirely — the bun site passes none (line 736). */
	depth: number | null
	/** `--no-edit` (uv, 661) or `--no-edit --no-ff` (bun, 748). */
	mergeFlags: string[]
	/** `git add -A` (uv, 691) or `git add <lockfile>` (bun, 776). */
	stageAll: boolean
	/** Treat a "nothing to commit" as a benign no-op (bun, 781). */
	tolerateNothingToCommit: boolean
	/** Characters of clone stderr quoted in the summary (200 vs 100). */
	cloneDetailWidth: number
	/** Whether the clone-failure summary quotes stderr at all (uv, 653 does not). */
	cloneDetail: boolean
	/**
	 * Run the frozen install BEFORE the re-resolve, as a diagnosis, and stop when
	 * it passes (bun, 759).
	 *
	 * FALSE FOR UV, and that is parity rather than an oversight: the uv flow
	 * shipped without a probe and simply runs `uv lock`, whose exit code is the
	 * diagnosis. Adding a `uv sync --locked` in front would change the argv a uv
	 * repo sees on every repair — a behaviour change dressed as a tidy-up.
	 *
	 * The rows that never existed before this table take the PROBE, because
	 * "already consistent" is a real outcome worth reporting instead of pushing an
	 * empty commit, and because it is the cheaper failure when CI is red for an
	 * unrelated reason.
	 */
	probeFirst: boolean
}

/**
 * The two toolchains whose flow predates this table, with their asymmetries
 * intact. Everything else takes `DEFAULT_SHAPE` — shallow clone, `--no-edit`,
 * stage by name, strict commit, probe first. That shape is the stricter of the
 * two: it refuses on ambiguity instead of tolerating it.
 */
const SHAPES: Record<string, FlowShape> = {
	bun: {
		depth: null,
		mergeFlags: ["--no-edit", "--no-ff"],
		stageAll: false,
		tolerateNothingToCommit: true,
		cloneDetailWidth: CLONE_DETAIL,
		cloneDetail: true,
		probeFirst: true,
	},
	uv: {
		depth: LOCKFIX_DEPTH,
		mergeFlags: ["--no-edit"],
		stageAll: true,
		tolerateNothingToCommit: false,
		cloneDetailWidth: DETAIL,
		cloneDetail: false,
		probeFirst: false,
	},
}

const DEFAULT_SHAPE: FlowShape = {
	depth: LOCKFIX_DEPTH,
	mergeFlags: ["--no-edit"],
	stageAll: false,
	tolerateNothingToCommit: false,
	cloneDetailWidth: DETAIL,
	cloneDetail: true,
	probeFirst: true,
}

const shapeOf = (pm: PackageManager): FlowShape => SHAPES[pm.id] ?? DEFAULT_SHAPE

/**
 * The infix between repo and PR in the clone's directory name.
 *
 * `uv` → `lockfix` (its name before the manager table existed), everything else
 * → `<id>fix`. Both shapes end in `fix`, which is the one thing
 * `workdirPrKey` in ./lockfix relies on to strip the infix before matching the
 * live-PR set — otherwise the sweep would treat a running repair as a stale one.
 */
const workdirInfix = (pm: PackageManager): string => (pm.id === "uv" ? "lockfix" : `${pm.id}fix`)

/** The merge-conflict and no-token summaries, which do not name a toolchain. */
const CONFLICT_SUMMARY = (baseRef: string) => `merge conflict with ${baseRef}`

/**
 * Re-resolve `pm`'s lockfile on the PR branch and push it, or report why not.
 *
 * The frozen install is the DIAGNOSIS, not a step: if it SUCCEEDS the lockfile
 * was never the problem, and the right answer is to say so and stop (line 759)
 * rather than re-resolve a consistent lockfile and push the noise.
 */
export async function fixLockfile(
	deps: LockfixDeps,
	pm: PackageManager,
	repo: string,
	pr: number,
	headRef: string,
	baseRef: string,
): Promise<{ ok: boolean; summary: string }> {
	const { run, exec, workdirs, fetchGhToken } = deps
	const shape = shapeOf(pm)
	// One workdir namespace per toolchain, so two rows repairing the same PR
	// cannot delete each other's clone mid-install. `uv` keeps its historical
	// `_lockfix_` name (it predates the id suffix) because the ops channel and a
	// human's `/tmp` both know that directory by that name.
	const workdir = `${TMP_BASE}/${String(repo).replace(/\//g, "_")}_${workdirInfix(pm)}_${pr}`

	if (workdirs.exists(workdir)) workdirs.remove(workdir) // Python 636-638, 725-727
	workdirs.mkdir(workdir)

	// Python 641/729: "Use gh token for auth (reliable PAT)" — this path does NOT
	// use the caller's own token for the clone, unlike the AI-fix one.
	const ghToken = fetchGhToken()
	if (!ghToken) {
		workdirs.remove(workdir)
		return { ok: false, summary: "no gh token" } // Python 644, 732
	}

	const cloned = clonePr(run, repo, headRef, ghToken, workdir, shape.depth)
	if (cloned.code !== 0) {
		workdirs.remove(workdir)
		return {
			ok: false,
			summary: shape.cloneDetail
				? `clone failed: ${head(reportable(cloned.stderr), shape.cloneDetailWidth)}`
				: "clone failed", // Python 653's bare string vs 741's quoted stderr
		}
	}

	// Python 659-662 / 747-749: merge the base so the lockfile matches CI's state.
	// The uv site fetches `--depth 5` to match its shallow clone (line 659); the
	// bun site fetched full history (747). Asking for a depth the clone does not
	// have is what re-deepens a full clone, so the flag follows the clone depth.
	const fetchArgs =
		shape.depth === null
			? ["fetch", "origin", baseRef]
			: ["fetch", "origin", baseRef, "--depth", String(shape.depth)]
	run(fetchArgs, workdir, FETCH_TIMEOUT_SEC)
	const merge = run(["merge", `origin/${baseRef}`, ...shape.mergeFlags], workdir, MERGE_TIMEOUT_SEC)
	if (merge.code !== 0) {
		run(["merge", "--abort"], workdir, ABORT_TIMEOUT_SEC) // Python 665, 751
		workdirs.remove(workdir)
		return { ok: false, summary: CONFLICT_SUMMARY(baseRef) } // Python 667, 753
	}

	// The frozen install is the DIAGNOSIS where the shape asks for it: a pass means
	// the lockfile was never the problem, so nothing is re-resolved or pushed.
	if (shape.probeFirst) {
		const frozen = exec(pm.frozenInstall.slice(), workdir, pm.frozenTimeoutSec)
		if (frozen.code === 0) {
			workdirs.remove(workdir)
			return { ok: false, summary: alreadyConsistent(pm) } // Python 759
		}
	}

	const sync = exec(pm.syncInstall.slice(), workdir, pm.syncTimeoutSec)
	if (sync.code !== 0) {
		const stderr = reportable(sync.stderr)
		workdirs.remove(workdir)
		// Python 764-766: tail 300, THEN head 100 of that tail.
		return {
			ok: false,
			summary: `${syncFailedLabel(pm)}: ${head(tail(stderr, STDERR_TAIL), DETAIL)}`,
		}
	}

	const diff = run(["diff", "--name-only"], workdir, DIFF_TIMEOUT_SEC)
	const changed = changedPaths(diff.stdout)

	if (!changed.length) {
		workdirs.remove(workdir)
		return { ok: false, summary: noChangeSummary(pm) } // Python 683, 774
	}

	// Python 686-689 / 771-774: commit only if the LOCKFILE is among the changes.
	// A re-resolve that touched only project files means the diagnosis was wrong,
	// and pushing it would smuggle an unrelated change onto the PR.
	if (!changed.some((path) => touchesManaged(pm, path))) {
		workdirs.remove(workdir)
		return { ok: false, summary: unexpectedFilesSummary(pm, changed) }
	}

	run(stagedPaths(shape, pm), workdir, ADD_TIMEOUT_SEC) // Python 691 / 776
	const commit = run(["commit", "-m", pm.commitMessage], workdir, COMMIT_TIMEOUT_SEC)
	// Python 781. The tolerance is real and asymmetric with the uv site: a
	// concurrent push can leave the worktree clean between the diff and the
	// commit, and for bun that is a benign no-op rather than a failure to report.
	const benign = shape.tolerateNothingToCommit && commit.stderr.includes("nothing to commit")
	if (commit.code !== 0 && !benign) {
		workdirs.remove(workdir)
		return { ok: false, summary: `commit failed: ${head(reportable(commit.stderr), DETAIL)}` }
	}

	const pushed = run(["push", "origin", `HEAD:${headRef}`], workdir, PUSH_TIMEOUT_SEC)
	workdirs.remove(workdir)

	if (pushed.code === 0) return { ok: true, summary: pushedSummary(pm) } // line 705/790
	return { ok: false, summary: `push failed: ${head(reportable(pushed.stderr), DETAIL)}` } // 706/791
}

// ── The summaries and staging, per row ──────────────────────────────────────
//
// Every one of these strings is read on the ops channel and the bun/uv ones are
// pinned by `test/pr-actions.test.ts`. They are functions rather than inline
// template literals because the two original flows word the SAME outcome
// differently ("uv lock failed" / "bun install sync failed", "no change (uv.lock
// already consistent)" / "bun install ran but bun.lock unchanged"), and keeping
// both wordings is the parity contract — not an oversight to be tidied.

const alreadyConsistent = (pm: PackageManager): string =>
	pm.id === "bun"
		? "bun.lock already consistent with package.json (CI failure elsewhere)"
		: `${pm.label} lockfile already consistent with the manifest (CI failure elsewhere)`

const syncFailedLabel = (pm: PackageManager): string =>
	pm.id === "bun" ? "bun install sync failed" : `${pm.label} install sync failed`

const noChangeSummary = (pm: PackageManager): string =>
	pm.id === "bun"
		? `bun install ran but bun.lock unchanged (unexpected files: ${JSON.stringify([])})`
		: `no change (${pm.lockfiles[0]} already consistent)`

const unexpectedFilesSummary = (pm: PackageManager, changed: string[]): string =>
	pm.id === "bun"
		? `bun install ran but bun.lock unchanged (unexpected files: ${JSON.stringify(changed.slice(0, FILE_CAP))})`
		: `unexpected files changed: ${JSON.stringify(changed.slice(0, FILE_CAP))}`

const pushedSummary = (pm: PackageManager): string =>
	pm.id === "bun" ? "bun.lock regenerated and pushed" : `${pm.lockfiles[0]} regenerated and pushed`

/** True when `path` is one of the files this row is allowed to have modified. */
const touchesManaged = (pm: PackageManager, path: string): boolean =>
	pm.managed.includes(basename(path))

/**
 * The `git add` argv: everything for a tool that may legitimately touch sibling
 * lockfiles (uv), only the ONE lockfile this repair owns otherwise — anything
 * else the installer wrote is a build artefact that must not ride along on the
 * PR. `bun.lock` and `bun.lockb` are alternatives, not a set: staging both puts
 * a path the repo does not have into argv and git fails on it.
 */
const stagedPaths = (shape: FlowShape, pm: PackageManager): string[] =>
	shape.stageAll ? ["add", "-A"] : ["add", pm.lockfiles[0] ?? pm.managed[0]]

// ── The two named flows, kept for their existing callers and suites ──────────
//
// `steps.ts` dispatches through `detectPackageManagers`, and these two remain
// because the Python-parity contract for bun and uv is expressed as a NAMED flow
// with a fixed signature: `test/pr-actions.test.ts` pins the argv, the workdir
// name and the summary string of each. They are thin wrappers, not a second
// implementation — every branch is `fixLockfile`'s.

/** Python `fix_uv_lock_for_trivial_pr(...)` (lines 627-706). */
export function fixUvLock(
	deps: LockfixDeps,
	repo: string,
	pr: number,
	headRef: string,
	baseRef: string,
): Promise<{ ok: boolean; summary: string }> {
	return fixLockfile(deps, managerNamed("uv"), repo, pr, headRef, baseRef)
}

/**
 * Python `fix_bun_lock_for_trivial_pr(...)` (lines 709-791).
 *
 * Root cause (2026-08-29): dependabot bumps `package.json` deps but bun.lock is
 * computed/resolved at install time by bun 1.3.14 differently than when the
 * lockfile was last committed, so CI's `--frozen-lockfile` rejects the PR even
 * though the code is correct.
 */
export function fixBunLock(
	deps: LockfixDeps,
	repo: string,
	pr: number,
	headRef: string,
	baseRef: string,
): Promise<{ ok: boolean; summary: string }> {
	return fixLockfile(deps, managerNamed("bun"), repo, pr, headRef, baseRef)
}

/** A row that must exist; a missing one is a wiring bug, not a runtime condition. */
function managerNamed(id: string): PackageManager {
	const pm = packageManagerById(id)
	if (!pm) throw new Error(`no package manager registered under "${id}"`)
	return pm
}

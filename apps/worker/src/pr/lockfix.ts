// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code; GitHub payloads are untyped JSON
/**
 * Lockfile pre-fixes for trivial (dependabot) PRs — port of
 * `scripts/pr-queue-worker.py` lines 589-597 (`is_trivial_pr`), 608-624
 * (`_repo_has_bun_lock`), 627-706 (`fix_uv_lock_for_trivial_pr`) and 709-791
 * (`fix_bun_lock_for_trivial_pr`).
 *
 * THE PROBLEM. Dependabot bumps `package.json` but not the lockfile, and bun /
 * uv re-resolve dependencies at install time, so CI's frozen-lockfile install
 * rejects the PR even though the code is fine. Both fixes are the same shape —
 * clone the branch, merge the base in (to match CI's merge state), re-resolve,
 * commit ONLY the lockfile, push — and they are kept separate because they
 * differ in five load-bearing details: the clone depth (5 / none), the merge
 * flags (`--no-edit` vs `--no-edit --no-ff`), the `git add` (`-A` vs
 * `bun.lock`), the commit message, and the "nothing to commit" tolerance.
 *
 * FOUR INVARIANTS:
 *
 * 1. TRUNCATION WIDTHS DIFFER PER SITE and are carried individually, each
 *    citing its Python line. Note `stderr[-300:][:100]` on the two lock
 *    commands: the TAIL is taken first and the HEAD of that, so the last words
 *    of a long error do NOT reach the summary. That reads like a bug and is
 *    what the Python reports today.
 * 2. CREDENTIALS ARE REDACTED OUT OF EVERY SUMMARY. A clone/push error echoes
 *    the credential URL back, and a summary reaches the ops Discord channel
 *    (report.ts). The Python inherited this leak (worker fix cc15d06); every
 *    stderr/stdout fragment below passes through `reportable` first.
 * 3. EVERY EXIT PATH REMOVES THE WORKDIR. The Python `rm -rf`s before each
 *    return, and a leaked clone is a leaked process tree.
 * 4. NO MODULE-SCOPE EFFECTS. `process.env` and the filesystem are reached only
 *    through the injected `deps`. Bun snapshots `homedir()` at process start, so
 *    a module-scope secret read made a suite pass only on the machine that
 *    happened to hold the real credential (the Task 8 lesson). Task 14 wires
 *    the real implementations.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { type GitResult, type GitRunner, redactCredentials, setBotIdentity } from "../git.ts"
import { detectPackageManagers } from "./managers.ts"
import type { GhClient } from "./scan.ts"

/** Python `TMP_BASE` (line 67). The parent of all three workdirs. */
export const TMP_BASE = "/tmp/pr-queue-work"

// `CLONE_TIMEOUT_SEC` is the one budget that stays here: it belongs to
// `clonePr` below. The rest of the lockfix budgets live in `./relock`,
// with the bodies that cite them.
const CLONE_TIMEOUT_SEC = 60 // 647-650, 735-738
// ── Shared injection types (autofix.ts imports these) ──────────────────────

/**
 * The workdir + PID-file lifecycle, narrowed to the five operations these
 * flows need. `nodeWorkdirs()` is the real implementation, for the Task 14
 * wiring.
 */
export type Workdirs = {
	exists(path: string): boolean
	mkdir(path: string): void
	/** `rm -rf` in the Python, and `unlink(missing_ok=True)` for the pid file. */
	remove(path: string): void
	writeFile(path: string, contents: string): void
	readFile(path: string): string
	/**
	 * Remove clone workdirs whose PR is not in `openKeys`, and return how many
	 * were removed. Optional so the many tests that inject a slim fake do not
	 * each have to grow a method they never exercise.
	 *
	 * This is the missing half of `pruneClosedFixState`. The clone is REUSED
	 * across ticks on purpose (see `autofix.ts`), and it was removed only on an
	 * error path, so one directory per PR ever touched accumulated under
	 * `/tmp/pr-queue-work` with nothing cleaning up after a PR closed. On
	 * 2026-10-17 that filled a 7.8G tmpfs and broke an unrelated deploy.
	 */
	sweepStale?(openKeys: ReadonlySet<string>): number
}

/**
 * A non-git program (`uv lock`, `bun install`). Same result shape as
 * `GitRunner` because the Python has one `subprocess.run` for both, but kept as
 * its own type so a test's two namespaces stay legible.
 */
export type ProcRunner = (args: string[], cwd?: string, timeoutSec?: number) => GitResult

/** What `fixUvLock` / `fixBunLock` need from the world. */
export type LockfixDeps = {
	/** Git. Never throws (git.ts). */
	run: GitRunner
	/** `uv` / `bun`. Never throws. */
	exec: ProcRunner
	workdirs: Workdirs
	/** Python `_fetch_gh_token()` (lines 599-605). `""` means "no PAT". */
	fetchGhToken: () => string
}

/**
 * Python's `err[:n]`, by CODE POINT.
 *
 * `String.prototype.slice` counts UTF-16 code units, so an emoji on the boundary
 * is cut in half and renders as U+FFFD — the mirror image of `git.ts`'s `tail`,
 * which exists for the same reason. Exported because `autofix.ts` needs the
 * same semantics for its `[:200]` / `[:300]` summaries.
 */
export function head(text: string, n: number): string {
	const points = [...text]
	return points.length <= n ? text : points.slice(0, n).join("")
}

/**
 * The single door between a command's output and a reported summary. Narrow by
 * design, like `redactCredentials`: only http(s) URL userinfo is rewritten, so
 * an ordinary git or bun error stays diagnosable.
 */
export function reportable(text: string): string {
	return redactCredentials(text)
}
/**
 * The credentialed clone URL — Python lines 646, 734 and 838, all one f-string.
 * Kept byte-identical to `git.ts`'s private `credentialUrl`.
 */
const credentialUrl = (token: string, repo: string): string =>
	`https://x-access-token:${token}@github.com/${repo}.git`

/**
 * The clone, returning the RESULT rather than a boolean.
 *
 * WHY NOT `git.ts`'s `cloneForPr`: two of the three clone sites quote the
 * clone's STDERR in their summary (lines 741, 845), which a boolean cannot
 * carry, and the bun site passes no `--depth` at all (line 736) where
 * `cloneForPr` always emits one. Both are facts about the Python, so the argv is
 * rebuilt here: same order (`clone`, url, dir, THEN `--branch`/`--depth`), same
 * 60s budget, same post-clone bot identity. `depth: null` omits the flag.
 */
export function clonePr(
	run: GitRunner,
	repo: string,
	branch: string,
	token: string,
	workdir: string,
	depth: number | null,
): GitResult {
	const args = ["clone", credentialUrl(token, repo), workdir, "--branch", branch]
	if (depth !== null) args.push("--depth", String(depth))
	const r = run(args, undefined, CLONE_TIMEOUT_SEC)
	if (r.code === 0) setBotIdentity(workdir, run) // Python lines 743-744 / 847-848
	return r
}

/**
 * The real `Workdirs`, on node:fs. Built lazily by the Task 14 wiring, so a
 * test that injects its own never touches the disk.
 */
export function nodeWorkdirs(): Workdirs {
	return {
		// `statSync`, not `existsSync`: a broken symlink is a real leftover workdir
		// that `existsSync` reports as absent, and Python's `Path.exists()` follows
		// symlinks the way `statSync` does.
		exists: (p) => {
			try {
				statSync(p)
				return true
			} catch {
				return false
			}
		},
		// Python's `mkdir(parents=True, exist_ok=True)`.
		mkdir: (p) => {
			mkdirSync(p, { recursive: true })
		},
		// Python's `rm -rf`, and `unlink(missing_ok=True)` for the pid file —
		// `force: true` covers both without a branch.
		remove: (p) => {
			rmSync(p, { recursive: true, force: true })
		},
		writeFile: (p, c) => {
			writeFileSync(p, c)
		},
		readFile: (p) => readFileSync(p, "utf8"),
		sweepStale: (openKeys) =>
			// Both leaks, one call: the clone workdirs keyed by open-PR set (plus
			// the age floor), and the prompt audits beside them keyed by age alone.
			// The second is easy to miss because it lives in the PARENT, not in the
			// directory the clone sweep walks.
			sweepStaleWorkdirs(TMP_BASE, openKeys) + sweepPromptAudits(TMP_BASE),
	}
}

/**
 * The name→PR-key mapping for a workdir under `TMP_BASE`, or `null` when the name
 * is not one of ours.
 *
 * THE INFIX IS LOAD-BEARING. Two flows create workdirs and only one has no
 * infix:
 *
 *   autofix.ts   `${repo}_${pr}`                 -> asepharyana_hub_47
 *   relock.ts    `${repo}_<id>fix_${pr}`         -> asepharyana_hub_pnpmfix_47
 *
 * The `<id>` is the `PackageManager.id` that owns the repair — `bunfix`,
 * `lockfix` (uv, before the row table), `npmfix`, `pnpmfix`, … — so the set is
 * open-ended and matched by SHAPE rather than by a list of known names. A hard
 * list here is what would silently start sweeping a live pnpm repair the day a
 * seventh toolchain was added.
 *
 * `repo` is the full `owner/name` with slashes replaced by underscores, so the
 * FIRST underscore separates owner from name and everything after the name is
 * either the PR or an infix + the PR. Stripping the infix is not cosmetic: the
 * naive `owner/name_<infix>_pr` key never matches the open set, so a LIVE PR's
 * relock workdir would be swept mid-use — a relock deleting the tree it is about
 * to run `npm ci` in. Caught by writing the test against the real function
 * instead of a copy of its logic.
 */
export function workdirPrKey(name: string): string | null {
	const m = /^(.+)_(\d+)$/.exec(name)
	if (!m) return null
	const repoPart = m[1].replace(/_[a-z0-9]+fix$/, "")
	const us = repoPart.indexOf("_")
	if (us < 0) return null
	return `${repoPart.slice(0, us)}/${repoPart.slice(us + 1)}/${m[2]}`
}

/**
 * How old a workdir must be before the sweep will touch it.
 *
 * THIS IS THE SAFETY OF THE SWEEP — the ONLY guard, and not a tidiness knob.
 *
 * The open-PR set comes from `gatherOpenPrs`, which can return a PARTIAL list or
 * an empty one on failure (a rate-limited or failed `/repos/:r/pulls` call yields
 * FEWER PRs, not an error), so "absent from the open set" alone is not grounds to
 * `rm -rf` anything: an open PR missing from a broken scan would have its workdir
 * deleted, and if a tick were mid-agent-run in that directory the clone would
 * vanish under it.
 *
 * The age floor closes that, because the two conditions must AGREE. A directory a
 * tick is using was touched minutes ago — the reuse path re-fetches and checks it
 * out every pass — while a stale one has not been touched since its PR closed. So
 * a bad scan can only ever remove directories nobody is using.
 *
 * AN EMPTY SCAN IS NOT SPECIAL, and an earlier revision got this wrong. It
 * returned early on `openKeys.size === 0`, which switched the sweep OFF in the one
 * state that accumulates the most garbage: with no open PRs anywhere, every
 * workdir is stale by definition. Measured on 2026-10-17 — 0 open PRs across all
 * repos, 56 stale workdirs, sweep skipped, /tmp still filling. The empty case is
 * now handled by the same age floor as every other case, which is the whole point
 * of having one: it does not need to know WHY a PR is missing from the scan.
 *
 * The cost of being wrong here is bounded and self-healing: deleting an old
 * workdir whose PR was merely invisible in a bad scan costs one re-clone on the
 * next good tick. NOT deleting is unbounded — it filled a 7.8G tmpfs and broke an
 * unrelated service's deploy. That asymmetry is why the floor is the only guard.
 *
 * 6h, not the 12h of the host-level reaper: this one additionally requires the PR
 * to be absent from a live scan, so it can afford a lower floor — and the worker
 * runs every 5 minutes, whereas the reaper runs hourly.
 */
export const SWEEP_MIN_AGE_HOURS = 6

/**
 * Remove every workdir under `dir` whose PR is not in `openKeys` AND whose mtime
 * is older than the age floor; return the count.
 *
 * Split out of `nodeWorkdirs()` so it can be tested against a temp directory.
 * An earlier version of this test re-implemented the mapping inline, which made
 * it pass while the shipped code was wrong — a test that copies the logic it is
 * meant to check verifies nothing.
 *
 * SAFETY. An unrecognised name is skipped rather than guessed at: one stale
 * directory is cheap, a wrong `rm -rf` costs a running clone mid-agent-run.
 *
 * @param opts.minAgeMs age floor; 0 disables it (tests only — the suite's `mk`
 *   helper backdates past the real floor so the shipped threshold is exercised).
 * @param opts.now injected clock, so a test never depends on wall time.
 */
export function sweepStaleWorkdirs(
	dir: string,
	openKeys: ReadonlySet<string>,
	opts: { minAgeMs?: number; now?: number } = {},
): number {
	const minAgeMs = opts.minAgeMs ?? SWEEP_MIN_AGE_HOURS * 3_600_000
	const now = opts.now ?? Date.now()
	let names: string[]
	try {
		names = readdirSync(dir)
	} catch {
		return 0 // no such directory yet: nothing to sweep, not an error.
	}
	let removed = 0
	for (const name of names) {
		const key = workdirPrKey(name)
		if (key === null || openKeys.has(key)) continue
		const path = `${dir}/${name}`
		// `statSync`, not the dirent's type: the mtime is what decides here, and a
		// broken symlink (a real leftover shape) must still be swept.
		let mtimeMs: number
		try {
			mtimeMs = statSync(path).mtimeMs
		} catch {
			continue // vanished between readdir and stat; nothing to do.
		}
		if (now - mtimeMs < minAgeMs) continue
		try {
			rmSync(path, { recursive: true, force: true })
			removed += 1
		} catch {
			// Leave it; one failure must not abort the tick's report.
		}
	}
	return removed
}

/**
 * Reclaim prompt-audit files in a workdir parent that are older than the floor.
 *
 * THE SECOND LEAK. `claude-agent.ts` writes `<label>.prompt.txt` beside the
 * workdir rather than inside it (`writeBestEffort(dirname(opts.workdir), …)`), so
 * it lands in `TMP_BASE` itself and is NOT covered by the workdir sweep — sweeping
 * directories removes the clone but leaves the file standing next to it forever.
 * 35 of them had accumulated when this was found, every one from a PR whose clone
 * had already been reclaimed.
 *
 * KEYED ON AGE ONLY, deliberately. The label is `claude_pr_<n>` — a PR number with
 * NO repo — so it cannot be matched against the open-PR set at all. Age is the
 * only signal available, and it is sufficient for an audit artifact: these exist
 * so a human can read what the agent was asked after the fact, which a day-old
 * file still serves. The floor therefore guards reachability of that purpose, not
 * correctness of the queue.
 *
 * 7 days rather than the workdir floor's 6h, because this is the opposite trade:
 * the file is tiny (about 1.2K), it is never read by the worker, and its whole
 * value is being there when something needs explaining. Long enough to survive a
 * weekend debugging session; short enough to not accumulate for a year.
 */
export const PROMPT_AUDIT_KEEP_DAYS = 7

export function sweepPromptAudits(
	dir: string,
	opts: { minAgeMs?: number; now?: number } = {},
): number {
	const minAgeMs = opts.minAgeMs ?? PROMPT_AUDIT_KEEP_DAYS * 86_400_000
	const now = opts.now ?? Date.now()
	let names: string[]
	try {
		names = readdirSync(dir)
	} catch {
		return 0
	}
	let removed = 0
	for (const name of names) {
		// `<label>.prompt.txt` is the only shape this owns. Anything else in the
		// parent — the state files, the lock, `cc-socks`, the pnpm store — is
		// either protected by the host reaper or belongs to another run, and is
		// NOT matched here.
		if (!name.endsWith(".prompt.txt")) continue
		const path = `${dir}/${name}`
		let mtimeMs: number
		try {
			mtimeMs = statSync(path).mtimeMs
		} catch {
			continue
		}
		if (now - mtimeMs < minAgeMs) continue
		try {
			rmSync(path, { force: true })
			removed += 1
		} catch {
			// Leave it.
		}
	}
	return removed
}

// ── is_trivial_pr ───────────────────────────────────────────────────────────

/**
 * Python `is_trivial_pr(title, author)` (lines 589-597): "Skip AI fix for
 * trivial PRs (dependabot bumps, docs-only, etc.)".
 *
 * The keyword list is transcribed verbatim and in order. Matching is a
 * SUBSTRING test against the LOWERCASED title, so "update" also matches
 * "refactor: update the parser" — a false positive, and the Python's behaviour.
 * This port does not get to fix it: a narrower rule changes which PRs reach the
 * AI agent, which changes cost and merge outcomes.
 *
 * `author` IS DELIBERATELY UNUSED. Python never reads it; adding an author check
 * would be a behaviour change disguised as a fix. It stays in the signature
 * because the pipeline calls it with an author (line 1912).
 */
export function isTrivialPr(title: string, _author: string): boolean {
	const trivialKw = [
		"dependabot",
		"update",
		"bump",
		"chore(deps)",
		"pin dependencies",
		"update version",
		"docs:",
		"readme",
		"changelog",
	]
	// `String(...)` mirrors Python's `str(title)`, so a null/undefined/number
	// title degrades instead of throwing inside a cron tick.
	const titleLower = String(title).toLowerCase()
	for (const kw of trivialKw) {
		if (titleLower.includes(kw)) return true // Python line 595
	}
	return false // Python line 597
}

// ── The per-toolchain probes and dispatch ───────────────────────────────────
//
// `repoHasBunLock` used to live here: Python's `_repo_has_bun_lock` (608-624),
// which asked a binary "is this a Bun repo" question and answered it by
// substring-matching `bun.lock` anywhere in the tree. That question cannot
// express the fleet's reality — one repo can hold a pnpm workspace AND a
// `uv.lock` — so detection moved to `./managers`, which returns EVERY toolchain
// the tree proves. The name is kept as a thin wrapper because the Python-parity
// suite pins it, and because a caller that genuinely wants the bun answer should
// not have to know the shape of the wider table.

/**
 * True when the repo tree at `sha` holds a `bun.lock` or `bun.lockb`.
 *
 * Delegates to `detectPackageManagers`, so its failure mode and its notion of
 * "is a lockfile" cannot drift from the dispatcher's. Still "EVERY failure means
 * no": an unreadable tree yields no toolchains, hence `false`.
 */
export async function repoHasBunLock(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
): Promise<boolean> {
	const found = await detectPackageManagers(api, token, repo, sha)
	return found.some((pm) => pm.id === "bun")
}

export { detectPackageManagers } from "./managers.ts"

import { fixBunLock, fixLockfile, fixUvLock } from "./relock.ts"

// Re-exported so `pipeline.ts` and the test suite keep importing the two
// flows from `./lockfix`, and so `steps.ts` can dispatch any row of the manager
// table without knowing which module owns the flow. This is a live re-export
// and `./relock` imports `clonePr`/`head`/`reportable` back, so the two modules
// form an ESM cycle; it is safe because nothing either module reads is touched
// at module-evaluation time.
export { fixBunLock, fixLockfile, fixUvLock }

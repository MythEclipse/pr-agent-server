// biome-ignore-all lint/suspicious/noExplicitAny: ported pr_agent code; GitHub payloads are untyped JSON
/**
 * Real AI auto-fix + the two side-cars it depends on — port of
 * `scripts/pr-queue-worker.py` lines 794-810 (`kill_orphaned_claude`),
 * 812-823 (`check_pr_still_valid`) and 825-961 (`run_ai_fix`), plus the
 * `AI_FIX_TIMEOUT` constant from line 76.
 *
 * THE SHAPE OF THE FLOW: clone the PR branch, work out which files it touches,
 * ask Claude Code to improve them, then decide whether it actually did anything,
 * and if so push for it. Three properties of that are contracts:
 *
 * 1. THE AGENT NEVER PUSHES. The prompt says so, and is transcribed byte-exact
 *    because it is the agent's only instruction boundary. The worker pushes,
 *    after proving there is something to push: `git rev-list --count
 *    <headSha[:12]>..HEAD` must be a parseable integer > 0 (lines 930-939). An
 *    unparseable count is ZERO, not an error — a bad revision means "nothing was
 *    committed", the honest reading.
 * 2. THE AGENT'S FAILURE TEXT IS THE SUMMARY (line 924). The `[INFRA]` prefix is
 *    the skip-once contract the pipeline keys on, so the snippet is passed
 *    through unworded — only its http(s) credential userinfo is rewritten (see
 *    the `reportable` call at line 363).
 * 3. A PID FILE TRACKS THE RUNNING WORKER (`kill_orphaned_claude`, deleted on
 *    every exit path of `run_ai_fix` at lines 922-923, 949-950, 955-956). It is
 *    a LEASE: a tick that dies mid-fix leaves its pid behind, and the next tick
 *    kills the orphan before starting a second agent on the branch.
 */
import { statSync } from "node:fs"
import type { PostResult } from "../claude-agent.ts"
import type { GitRunner } from "../git.ts"
import { clonePr, head, reportable, TMP_BASE, type Workdirs } from "./lockfix.ts"
import type { GhClient } from "./scan.ts"

/** Python `TRACKING_DIR` (line 81) — the PID-file directory. */
export const TRACKING_DIR = "/tmp/pr-queue-pids"

/**
 * Python `AI_FIX_TIMEOUT = 1800` (line 76) — seconds per PR, covering agent
 * turns AND tool calls, not one inference. Deliberately NOT a neighbour's
 * constant: `AI_FIX_MAX_TURNS` (100) is the gateway's turn cap and
 * `SYNC_CLAUDE_TIMEOUT` (3600) is the upstream-sync agent's.
 */
export const AI_FIX_TIMEOUT = 1800

/** Python `AI_FIX_MAX_TURNS` (line 75) — reported, never enforced here. */
const AI_FIX_MAX_TURNS = 100

// ── Timeout budgets, one per Python `subprocess.run(..., timeout=N)` ─────────
const FETCH_TIMEOUT_SEC = 30 // lines 851-854
/** The fast-forward / hard-reset checkout when reusing a worktree. */
const CHECKOUT_TIMEOUT_SEC = 30
const DIFF_TIMEOUT_SEC = 15 // lines 857-860
const REV_LIST_TIMEOUT_SEC = 10 // lines 929-932
/** The post-push `git rev-parse HEAD` that reads back the tip the fix landed. */
const REV_PARSE_TIMEOUT_SEC = 10
const PUSH_TIMEOUT_SEC = 60 // lines 943-946
/** Python `time.sleep(2)` between SIGTERM and SIGKILL (line 804). */
const SIGKILL_GRACE_MS = 2000
/** Python `changed_files[:30]` in the prompt (line 884). */
const FILE_CAP = 30
const SNIPPET = 300 // `snippet[:300]` — line 961
const PUSH_DETAIL = 200 // `(stderr or stdout or "")[:200]` — line 951

// ── Injection types ─────────────────────────────────────────────────────────

/** The `agent.post` seam. `AgentClient` satisfies it structurally. */
export type AgentPort = {
	post(prompt: string, opts: PostOptions): Promise<PostResult>
}

/** `claude-agent.ts`'s `PostOptions`, narrowed to the two fields set here. */
export type PostOptions = { workdir?: string; label?: string; timeoutSec?: number }

/** The report buffer (report.ts) — optional, so a caller can drop the line. */
export type ReportPort = { push(line: string): void }

export type AiFixDeps = {
	run: GitRunner
	workdirs: Workdirs
	agent: AgentPort
	/** Only used for the changed-files fallback (Python lines 864-876). */
	api: GhClient
	report?: ReportPort
}

/** The process effects of `kill_orphaned_claude`, all injected. */
export type ProcessDeps = {
	workdirs: Workdirs
	/** Python's `Path(f"/proc/{pid}").exists()` (lines 800, 805). */
	procExists(pid: number): boolean
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void
	/** Python's `time.sleep(2)` (line 804). */
	sleep(ms: number): void
	/** `os.getpid()` (line 810) — the pid written into the tracking file. */
	pid: number
}

/** Python's `(is_valid, head_sha, mergeable, error_reason)` — lines 813, 817-823. */
export type PrStillValid = [boolean, string, any, string]

// ── pid bookkeeping ─────────────────────────────────────────────────────────

/**
 * `TRACKING_DIR / f"{repo}_{pr}.pid"` — Python lines 796, 922, 949, 955. The
 * repo's `/` becomes `_`; every site derives the SAME name, which is what makes
 * the delete on the exit paths match the file `killOrphanedAgent` wrote.
 */
export function pidFileFor(repo: string, pr: number): string {
	return `${TRACKING_DIR}/${String(repo).replace(/\//g, "_")}_${pr}.pid`
}

/** Python's `os.getpid()`, `Path("/proc/<pid>").exists()` and signals. */
export function nodeProcessDeps(workdirs: Workdirs): ProcessDeps {
	return {
		workdirs,
		procExists: (pid) => {
			try {
				// Python's `Path(f"/proc/{pid}").exists()` (lines 800, 805). Linux-only
				// by construction: elsewhere always false, which means "no orphan to
				// kill" — the safe direction for a signal.
				statSync(`/proc/${pid}`)
				return true
			} catch {
				return false
			}
		},
		kill: (pid, signal) => process.kill(pid, signal),
		// A real 2s grace period, so it has to actually elapse before the SIGKILL
		// check. `Atomics.wait` blocks without spinning, and this is the ONE place
		// in the worker that wants that: the Python's `time.sleep(2)` is likewise a
		// synchronous wait, on a different process.
		sleep: (ms) => {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
		},
		pid: process.pid,
	}
}

// ── kill_orphaned_claude ────────────────────────────────────────────────────

/**
 * Python `kill_orphaned_claude(repo_full, pr_num)` (lines 794-810): "Kill any
 * previously-running Claude process on this PR." The sequence is TERM, wait 2s,
 * KILL — escalation, because a `git merge` in flight should be allowed to
 * unwind. The write of OUR OWN pid happens on EVERY path: that write is the
 * lease, and skipping it would leave the next tick no orphan to clean up. A
 * garbage pid file and a dead pid are both swallowed.
 */
export function killOrphanedAgent(deps: ProcessDeps, repo: string, pr: number): void {
	const pidFile = pidFileFor(repo, pr)
	if (deps.workdirs.exists(pidFile)) {
		try {
			// Python line 799: `int(pid_file.read_text().strip())`.
			const oldPid = Number.parseInt(deps.workdirs.readFile(pidFile).trim(), 10)
			if (Number.isInteger(oldPid) && deps.procExists(oldPid)) {
				deps.kill(oldPid, "SIGTERM")
				deps.sleep(SIGKILL_GRACE_MS)
				if (deps.procExists(oldPid)) deps.kill(oldPid, "SIGKILL")
			}
		} catch {
			/* Python line 807: `except (ValueError, OSError, ProcessLookupError)` */
		}
	}
	deps.workdirs.mkdir(TRACKING_DIR) // Python line 809
	deps.workdirs.writeFile(pidFile, String(deps.pid)) // Python line 810
}

// ── check_pr_still_valid ────────────────────────────────────────────────────

/**
 * Python `check_pr_still_valid(token, repo_full, pr_num, original_sha)`
 * (lines 812-823): "Re-fetch PR. Returns (is_valid, head_sha, mergeable,
 * error_reason). False if someone merged/closed/pushed new commits."
 *
 * The caller has held a head sha for minutes, so this re-validates before
 * acting on it. The THIRD return is the interesting one: a new head means the
 * PR is invalid AS THE CALLER SAW IT, but Python still returns the new sha and
 * the mergeable flag (line 822) so the pipeline can adopt them.
 */
export async function checkPrStillValid(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
	originalSha: string,
): Promise<PrStillValid> {
	const { status, data } = await api.request("GET", `/repos/${repo}/pulls/${pr}`, { token })
	// Python line 816: `not isinstance(data, dict)` — github.ts returns `{}` for
	// an unparseable body, and a non-object body must not reach `.get`.
	if (status !== 200 || data === null || typeof data !== "object" || Array.isArray(data)) {
		return [false, "", undefined, "failed to fetch PR"] // line 817
	}
	if (data.state !== "open" || data.merged) {
		return [false, "", undefined, "PR was closed/merged"] // line 819
	}
	// `data.head?.sha` guarded by a type check — Python's
	// `data.get("head", {}).get("sha", "")`, plus a `head: null` where the Python
	// would RAISE. A deliberate safe divergence on a shape GitHub does not send.
	const newSha = typeof data.head?.sha === "string" ? data.head.sha : ""
	if (newSha && newSha !== originalSha) {
		return [false, newSha, data.mergeable, "PR was updated by someone else"] // line 822
	}
	return [true, newSha, data.mergeable, ""] // line 823
}

// ── run_ai_fix ──────────────────────────────────────────────────────────────

/**
 * The prompt, transcribed from Python lines 888-911.
 *
 * LOAD-BEARING, do not reflow: "4. Do NOT push" is the boundary that keeps the
 * agent from pushing a commit the worker has not validated, and the merge-base
 * instruction must come FIRST (step 1 before step 2) or the agent improves code
 * against a base it is about to merge. The commit message is exact — the
 * pipeline matches on `[skip ci]`.
 */
export function buildAiFixPrompt(
	pr: number,
	repo: string,
	title: string,
	baseRef: string,
	changedFiles: string[],
): string {
	let fileList = changedFiles
		.slice(0, FILE_CAP)
		.map((f) => `  - ${f}`)
		.join("\n")
	if (changedFiles.length > FILE_CAP) {
		fileList += `\n  ... and ${changedFiles.length - FILE_CAP} more` // Python line 886
	}
	return (
		`You are on the PR #${pr} branch of ${repo}: "${title}"\n\n` +
		"Files changed in this PR:\n" +
		fileList +
		"\n\n" +
		"Your working directory is the git worktree for this PR branch.\n" +
		"Your task:\n" +
		"1. FIRST, try to merge the base branch to resolve any stale conflicts:\n" +
		`     git fetch origin ${baseRef}\n` +
		`     git merge origin/${baseRef} --no-edit\n` +
		"   If there are merge conflicts, resolve them intelligently\n" +
		"2. THEN improve code quality of ALL changed files:\n" +
		"   - Fix naming, DRY up repeated logic, add error handling\n" +
		"   - Add type hints / type annotations where missing\n" +
		"   - Fix anti-patterns, improve structure, add docstrings\n" +
		"3. Commit ALL changes with EXACT message:\n" +
		'     git add -A && git commit --message="fix: auto-fix code quality [skip ci]"\n' +
		"4. Do NOT push — a separate step pushes your commit.\n\n" +
		"CRITICAL RULES:\n" +
		"- ONLY modify the files listed above (plus commit/merge resolution)\n" +
		"- Do NOT change program logic or add features\n" +
		"- Resolve merge conflicts carefully - keep BOTH sides where needed\n" +
		"- You are mytheclipsebotreview - git identity already set\n" +
		'- Use EXACTLY "fix: auto-fix code quality [skip ci]" as the commit message'
	)
}

/**
 * The `run_ai_fix` verdict. `tipSha` is the commit the branch is at AFTER the
 * worker's push — the head a `markFixed` record must name (see `stepAiFix`).
 * Empty whenever nothing was pushed, which makes "no push" indistinguishable
 * from "push did not move anything", exactly as it should be.
 */
export type AiFixResult = { ok: boolean; summary: string; commits: number; tipSha: string }

/**
 * Python `run_ai_fix(repo_full, pr_num, title, head_sha, head_ref, base_ref,
 * token)` (lines 825-961).
 *
 * "REAL AI auto-fix: clone PR branch, run Claude Code for quality improvements,
 * commit + push fixes." Three Python behaviours worth naming because they look
 * like mistakes:
 *   - the changed-file set comes from a 3-dot diff (`origin/base...`) — "files
 *     this PR changed", not "files that differ from base" (line 858);
 *   - the GitHub files endpoint is a FALLBACK, best-effort, and its failure is
 *     swallowed (lines 864-876) — git's answer is authoritative. That `try` also
 *     holds the `f["filename"]` lookup, so a malformed entry ends the fallback
 *     rather than yielding `undefined`;
 *   - the agent's prompt is written to disk by `AgentClient.post` (claude-agent.ts),
 *     not here. Python line 917 does it inline, but doing it twice would let
 *     the file's content drift from what the agent received.
 */
export async function runAiFix(
	deps: AiFixDeps,
	repo: string,
	pr: number,
	title: string,
	headSha: string,
	headRef: string,
	baseRef: string,
	token: string,
): Promise<AiFixResult> {
	const { run, workdirs, agent, api } = deps
	// NOTE: no `_lockfix_`/`_bunfix_` infix here (Python line 831), so the three
	// flows' workdirs cannot collide in /tmp. `TMP_BASE` is the shared constant,
	// not a re-typed literal, so the paths cannot drift apart.
	const workdir = `${TMP_BASE}/${String(repo).replace(/\//g, "_")}_${pr}`
	const pidFile = pidFileFor(repo, pr)

	// REUSE THE CLONE ACROSS TICKS. `git workdirs.remove(workdir)` on entry (the
	// Python's line 833) deleted the clone and re-cloned from scratch on EVERY
	// attempt, so a PR that needed several passes started from zero each time:
	// same shallow history, same diff, same prompt, same ground — and any work an
	// earlier pass had done locally was thrown away. That is the "restart from
	// the initial state instead of continuing" behaviour, and it is why an agent
	// that should converge instead oscillated.
	//
	// A reused worktree is safe only if it is FAST-FORWARDED to the head we are
	// about to act on, because the head may have moved since the last tick. A
	// dirty tree is dropped rather than reused: an earlier pass left uncommitted
	// edits, and continuing from them would let one agent's abandoned scratch work
	// become the next agent's starting point.
	const reuse = workdirs.exists(workdir) && workdirClean(run, workdir)
	if (!reuse) {
		if (workdirs.exists(workdir)) workdirs.remove(workdir)
		workdirs.mkdir(workdir)
		const cloned = clonePr(run, repo, headRef, token, workdir, 20) // Python line 840
		if (cloned.code !== 0) {
			workdirs.remove(workdir)
			return {
				ok: false,
				commits: 0,
				tipSha: "",
				summary: `clone failed: ${head(reportable(cloned.stderr), 200)}`,
			} // line 845
		}
	} else {
		// Fast-forward onto the current head; fall back to a fresh clone if the
		// worktree cannot get there (diverged, or the branch moved under us).
		const ff = run(["fetch", "origin", headRef], workdir, FETCH_TIMEOUT_SEC)
		const co = run(["checkout", "-B", headRef, `FETCH_HEAD`], workdir, CHECKOUT_TIMEOUT_SEC)
		if (ff.code !== 0 || co.code !== 0) {
			workdirs.remove(workdir)
			workdirs.mkdir(workdir)
			const cloned = clonePr(run, repo, headRef, token, workdir, 20)
			if (cloned.code !== 0) {
				workdirs.remove(workdir)
				return {
					ok: false,
					commits: 0,
					tipSha: "",
					summary: `clone failed: ${head(reportable(cloned.stderr), 200)}`,
				}
			}
		}
	}

	// Python lines 851-854: the shallow clone lacks the base, so fetch it before
	// diffing. The result is ignored in the Python and here.
	run(["fetch", "origin", baseRef, "--depth", "10"], workdir, FETCH_TIMEOUT_SEC)

	// Python lines 857-861. `--diff-filter=ACMR` drops deletions: a deleted file
	// has nothing to improve. The three dots are load-bearing — two dots would
	// include every commit the merge brought in.
	const diff = run(
		["diff", "--name-only", `origin/${baseRef}...`, "--diff-filter=ACMR"],
		workdir,
		DIFF_TIMEOUT_SEC,
	)
	let changedFiles = diff.stdout
		.split("\n")
		.map((f) => f.trim())
		.filter((f) => f.length > 0)

	// Python lines 864-876. Best-effort fallback, inside its own try (which also
	// absorbs a network failure, so it must stay), filtered to the same ACMR set
	// so the two sources cannot disagree about what "changed" means.
	if (!changedFiles.length) {
		try {
			const { status, data } = await api.request(
				"GET",
				`/repos/${repo}/pulls/${pr}/files?per_page=50`,
				{
					token,
				},
			)
			if (status === 200 && Array.isArray(data)) {
				changedFiles = (data as any[])
					.filter((f) => ["added", "modified", "renamed", "copied"].includes(f?.status))
					// `f["filename"]`, NOT `f?.filename`: Python raises KeyError on a
					// missing key, the `except` drops the WHOLE comprehension, and the
					// guard then returns "no changed files to fix" BEFORE any agent call.
					// `?.` would instead spend a paid 1800s run on a file list reading
					// "undefined".
					.map((f) => {
						if (typeof f?.filename !== "string") throw new Error("KeyError: filename")
						return f.filename
					})
			}
		} catch {
			/* Python line 875-876: `except Exception: pass` */
		}
	}

	if (!changedFiles.length) {
		workdirs.remove(workdir)
		return { ok: false, commits: 0, tipSha: "", summary: "no changed files to fix" } // Python line 880
	}

	const prompt = buildAiFixPrompt(pr, repo, title, baseRef, changedFiles)
	// Python line 913.
	// The turn cap is the CLI's `--max-turns` budget. Reported for the operator's
	// benefit; the CLI enforces its own default when the flag is omitted.
	deps.report?.push(`   🤖 Running Claude Code AI fix (max ${AI_FIX_MAX_TURNS} turns)...`)

	const label = `claude_pr_${pr}`
	const { ok, snippet } = await agent.post(prompt, {
		workdir,
		timeoutSec: AI_FIX_TIMEOUT,
		label,
	})
	if (!ok) {
		workdirs.remove(workdir)
		workdirs.remove(pidFile) // Python lines 922-923
		// VERBATIM, the [INFRA] contract (line 924) — "verbatim" means the agent's
		// own words, not a paraphrase, and those words are UNTRUSTED: the session
		// ran with terminal tools in the workdir whose `.git/config` holds the
		// credentialed clone URL, and quoting a remote is a natural thing to do.
		// `reportable` is narrow (http(s) userinfo only), so an ordinary `[INFRA]`
		// line is byte-identical and the skip-once pipeline still matches. See
		// :398 for the same wrap on the other snippet site.
		return { ok: false, commits: 0, tipSha: "", summary: reportable(snippet) }
	}

	// Python lines 927-939. Twelve characters of the ORIGINAL head sha: a full
	// sha is not what a report should carry, and git resolves the short form.
	const revList = run(
		["rev-list", "--count", `${headSha.slice(0, 12)}..HEAD`],
		workdir,
		REV_LIST_TIMEOUT_SEC,
	)
	// Python's `int(r3.stdout.strip())` inside a try: unparseable leaves the count
	// at zero, i.e. "the agent committed nothing".
	const newCommits = Number.parseInt(revList.stdout.trim(), 10)
	const committed = Number.isInteger(newCommits) && newCommits > 0

	if (committed) {
		// The worker pushes the agent's commit — the agent must not (prompt rule 4).
		const pushed = run(["push", "origin", `HEAD:${headRef}`], workdir, PUSH_TIMEOUT_SEC)
		if (pushed.code !== 0) {
			workdirs.remove(workdir)
			workdirs.remove(pidFile) // Python lines 949-950
			// Python line 951: `stderr or stdout or ""` — stderr first, stdout as the
			// fallback, empty last, then 200 characters.
			const detail = reportable(pushed.stderr || pushed.stdout || "")
			return {
				ok: false,
				commits: 0,
				tipSha: "",
				summary: `AI committed but push failed: ${head(detail, PUSH_DETAIL)}`,
			}
		}
	}

	// THE TIP THE PUSH CREATED, read while the workdir still exists. This is the
	// head a `markFixed` record must name: the caller cannot get it from GitHub,
	// because `GET /pulls/:n` lags the push by seconds-to-minutes and that lag is
	// precisely how hub#53 looped. Read here rather than at the call site because
	// the workdir is removed a few lines down, and because `HEAD` in it IS the
	// pushed commit — the same object that is now on the branch.
	//
	// Best-effort by design: an unreadable tip stays empty and the caller falls
	// back to the head it already had, which is the pre-fix behaviour. A missing
	// optimisation must never turn a successful fix into a failure.
	const tip = committed
		? run(["rev-parse", "HEAD"], workdir, REV_PARSE_TIMEOUT_SEC).stdout.trim()
		: ""
	const tipSha = /^[0-9a-f]{40}$/i.test(tip) ? tip : ""

	// BEFORE the teardown below: `workdir` is gone a few lines down, and this is
	// the only reading of what the agent left behind.
	const cleanTree = !committed && workdirClean(run, workdir)

	// The PID file is always cleared — that is the orphan lease, and leaving it
	// would make the next tick kill a process that no longer exists.
	workdirs.remove(pidFile) // Python lines 955-956

	// The workdir itself is KEPT, and this is the change that makes progress
	// survive a tick. The Python removed it here (line 954) unconditionally, so
	// every attempt began from a brand-new clone and an agent working on a
	// multi-pass problem restarted from the same ground forever.
	//
	// Kept only when CLEAN. A dirty tree means an agent abandoned edits, and
	// making the next agent continue from another agent's scratch is how a
	// half-finished idea becomes an unreviewed commit. A dirty workdir is
	// discarded and the next tick re-clones.
	if (!cleanTree) workdirs.remove(workdir)
	// A committed-and-pushed workdir is stale by definition — its commit is on
	// the branch now — so it is dropped rather than carried.
	else if (committed) workdirs.remove(workdir)

	if (committed)
		return {
			ok: true,
			commits: newCommits,
			tipSha,
			summary: `Claude Code pushed ${newCommits} improvement commit(s)`,
		} // line 959
	// `reportable` BEFORE `head()`: same untrusted-agent-text reasoning as the
	// `[INFRA]` site above, and truncating first would not help — the credential
	// sits near the start of a quoted `.git/config` line, well inside 300 points.
	const said = reportable(snippet ?? "")
	// A CLEAN TREE IS A SUCCESS, not a failure. The agent ran, found the code
	// already in the shape it was asked to improve, and correctly committed
	// nothing. Reporting `ok:false` here is what turned that into an infinite
	// loop: the caller treats a non-ok summary as a fix that failed, and since
	// this is not an `[INFRA]` failure nothing is recorded against the SHA, so
	// EVERY tick paid for another 1800s agent run to reach the same conclusion.
	// Six PRs sat in exactly that loop; the message even named the file the
	// agent refused to double-add (`ailing-newline fix landed identically to
	// what 2d50b61 already had staged`).
	//
	// `ok:true` is the honest report AND the fix: `stepAiFix` calls `markFixed`
	// on it, so this SHA is not re-attempted and the pipeline falls through to
	// the safety/CI/merge gates. The distinction that must stay is `ok` = "the
	// fix phase completed", not "a commit exists" — the commit count is
	// reported in the summary either way, and the `cleanTree ? … : …` arms keep
	// the two very different "no commit" causes visible in the report instead
	// of collapsing them into one ambiguous line.
	return {
		ok: true,
		// 0 is the load-bearing value here, and it is what `shouldRetryAiFix`
		// reads. A clean tree means the agent found nothing to improve, so the
		// recorded "fixed" says nothing about whether the PR can actually merge —
		// which is exactly the mcpedia#28 shape: honest clean tree, red CI, and
		// then "Already fixed at this SHA" forever. The dirty arm below also has
		// no commit, but the workdir is discarded for that case, so 0 is right
		// for both.
		commits: 0,
		// Nothing was pushed, so there is no new head to name.
		tipSha: "",
		summary: cleanTree
			? `Claude Code found nothing to improve — no changes needed (${head(said, SNIPPET)})`
			: `Claude Code ran but left uncommitted changes (${head(said, SNIPPET)})`,
	} // line 961
}

/**
 * Did the agent finish with a clean working tree?
 *
 * The load-bearing check behind the "nothing to improve" reading above, because
 * "no commit" has two very different causes and only one of them is success:
 *
 *   - the agent improved the code and simply never ran `git commit` (it hit the
 *     turn cap, or it decided the work was not worth a commit). Real work is
 *     sitting uncommitted in a directory the worker is about to delete. That MUST
 *     stay a failure, or it is destroyed silently.
 *   - the agent made no edits at all. There is nothing to lose.
 *
 * `git status --porcelain` is the honest discriminator: empty output is the
 * second case, and any output is the first. It runs on the INJECTED `run`, like
 * every other git call in this module, so a test drives it with the same fake
 * and no test ever shells out. A git failure is not "clean" — the check can
 * only ever downgrade a clean tree to "uncommitted work".
 */
function workdirClean(run: GitRunner, workdir: string): boolean {
	const r = run(["status", "--porcelain"], workdir, REV_LIST_TIMEOUT_SEC)
	return r.code === 0 && r.stdout.trim() === ""
}

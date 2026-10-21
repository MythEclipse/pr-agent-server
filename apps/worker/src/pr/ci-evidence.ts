// WHAT BROKE, for the agent.
//
// The AI fix sees one generic prompt on every run: "improve code quality of ALL
// changed files". It is never told WHY the PR is stuck. That is fine for a branch
// with nothing wrong, and useless for the case that actually blocks the queue — a
// red CI caused by a real failure the agent must diagnose. Measured: mcpedia#28 sat
// on `⏭️ Already fixed at this SHA` for 97 consecutive ticks with a red CI, because a
// vitest bump has nothing to "improve" and the blocker was CI itself.
//
// So the pre-fix pipeline reads the failure out of GitHub and puts it IN the prompt.
// The data comes from check-run ANNOTATIONS (`/check-runs/{id}/annotations`), which
// is where GitHub stores path, line and a message for a failing job. `check-runs`
// itself carries `output.summary`/`output.text` for composite actions, but for the
// Actions runner the useful content is in annotations — a failing `pnpm test`
// annotates the assertion, a typecheck annotates the file and line.
//
// Everything here is BEST-EFFORT and never throws. A prompt with no evidence is the
// prompt we already had; a prompt step that blew up would take the whole PR down
// with it, and "we could not read GitHub's annotations" is not a reason to skip a
// review.

import type { GhClient } from "./scan.ts"

/** One failing job, reduced to what a prompt can use. */
export interface TCiFailure {
	/** Check-run name, e.g. `verify` or `test (20.x)`. */
	name: string
	/** GitHub's conclusion: failure | timed_out | cancelled | startup_failure | … */
	conclusion: string
	/** Annotations, already trimmed; empty when the run published none. */
	annotations: TAnnotation[]
	/** `output.summary`/`output.text` when a composite action wrote one. */
	output: string
}

export interface TAnnotation {
	path: string
	line: number | null
	level: string
	message: string
}

/**
 * Caps, because this text goes into a prompt and the model's window is finite.
 * Per-annotation message length matters most: a stack trace annotation can be
 * thousands of characters on its own, and ten of those would drown the diff.
 */
const MAX_FAILING_JOBS = 3
const MAX_ANNOTATIONS_PER_JOB = 5
const MAX_MESSAGE_CHARS = 900
const MAX_OUTPUT_CHARS = 1200
/** Total budget for the whole evidence block, so one pathological run cannot
 *  crowd out the changed-file list the prompt also has to carry. */
const MAX_TOTAL_CHARS = 6000

const RED = new Set([
	"failure",
	"timed_out",
	"cancelled",
	"action_required",
	"stale",
	"startup_failure",
])

const clip = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max)}… [truncated, ${s.length - max} more chars]`

/** GitHub returns `start_line`/`line` inconsistently; either is good enough. */
const lineOf = (a: Record<string, unknown>): number | null => {
	const n = a.start_line ?? a.line
	return typeof n === "number" && Number.isFinite(n) ? n : null
}

const strOf = (v: unknown): string => (typeof v === "string" ? v : "")

/**
 * Read the failing checks and their annotations for a SHA.
 *
 * Returns `[]` for every failure mode — a green run, a repo with no checks, a
 * token without `checks:read`, a GitHub 5xx. The caller treats an empty list as
 * "no evidence available" and falls back to the generic prompt, which is exactly
 * the behaviour that existed before this module.
 */
export async function collectCiFailures(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
): Promise<TCiFailure[]> {
	// THE WHOLE BODY IS GUARDED, not just the per-annotation read.
	//
	// `api.request` THROWS on a transport failure (a refused socket, a DNS
	// failure) rather than returning a status — found by a test that stubs the
	// client to throw `ECONNREFUSED` and asserts `runAiFix` still degrades to the
	// git answer. Without this guard the evidence read turned a recoverable
	// network blip into a thrown error that failed the entire agent run, which is
	// the opposite of the "best-effort" contract this module states.
	try {
		const res = await api.request("GET", `/repos/${repo}/commits/${sha}/check-runs`, { token })
		if (res.status !== 200) return []

		const data = res.data as { check_runs?: unknown } | null
		const runs = Array.isArray(data?.check_runs)
			? (data.check_runs as Record<string, unknown>[])
			: []

		const failing = runs
			.filter((r) => r.status === "completed" && RED.has(strOf(r.conclusion)))
			.slice(0, MAX_FAILING_JOBS)

		const failures: TCiFailure[] = []
		for (const run of failing) {
			const output = run.output as Record<string, unknown> | null | undefined
			failures.push({
				name: strOf(run.name) || "(unnamed check)",
				conclusion: strOf(run.conclusion),
				annotations: await readAnnotations(api, token, repo, run),
				output: clip(
					[strOf(output?.title), strOf(output?.summary), strOf(output?.text)]
						.filter(Boolean)
						.join("\n"),
					MAX_OUTPUT_CHARS,
				),
			})
		}
		return failures
	} catch {
		// A prompt with no evidence is the prompt we already had. An exception here
		// would take the PR down over a diagnostic.
		return []
	}
}

/**
 * Annotations for one check run. A per-run read is needed because the list
 * endpoint does not embed them. 403/404 is normal (the App may lack
 * `checks:read` on some installs) and is not worth reporting.
 */
async function readAnnotations(
	api: GhClient,
	token: string,
	repo: string,
	run: Record<string, unknown>,
): Promise<TAnnotation[]> {
	const id = run.id
	if (typeof id !== "number") return []
	const res = await api.request("GET", `/repos/${repo}/check-runs/${id}/annotations`, { token })
	if (res.status !== 200 || !Array.isArray(res.data)) return []

	return (
		(res.data as Record<string, unknown>[])
			// LEVEL FILTER: a check run publishes `notice`/`warning` annotations
			// alongside the failures, and they are not what broke the build. Observed
			// on a real `hub` run, where a `notice` about the `ubuntu-latest` image
			// migration was listed immediately after the actual Dependabot error —
			// handing that to an agent invites it to "fix" an unrelated runner label.
			.filter((a) => strOf(a.annotation_level) === "failure")
			.filter((a) => strOf(a.message).trim() !== "")
			.slice(0, MAX_ANNOTATIONS_PER_JOB)
			.map((a) => ({
				path: strOf(a.path),
				line: lineOf(a),
				level: strOf(a.annotation_level),
				message: clip(strOf(a.message), MAX_MESSAGE_CHARS),
			}))
	)
}

/**
 * Render the evidence as prompt text.
 *
 * Written as an instruction, not a log dump: the agent is told what to DO with
 * each failure and, crucially, told NOT to rewrite a workflow file to make a
 * failing test disappear. That is the failure mode a capable agent reaches for
 * when it is handed a red CI and no rule about it — and it produces a green PR
 * that fixed nothing.
 */
export function renderCiFailures(failures: readonly TCiFailure[]): string {
	if (failures.length === 0) return ""
	const blocks = failures.map((f) => {
		const lines = [`### ${f.name} — ${f.conclusion}`]
		if (f.output) lines.push(clip(f.output, MAX_OUTPUT_CHARS))
		for (const a of f.annotations) {
			const where = a.path ? `${a.path}${a.line === null ? "" : `:${a.line}`}` : ""
			lines.push(`- ${where ? `[${where}] ` : ""}${a.message}`)
		}
		if (f.annotations.length === 0 && !f.output) {
			lines.push(
				"(GitHub published no annotation or log summary for this job — open it to read the log.)",
			)
		}
		return lines.join("\n")
	})

	return clip(blocks.join("\n\n"), MAX_TOTAL_CHARS)
}

/**
 * The prompt section. Only emitted when there IS evidence, so an ordinary
 * "improve the code" run keeps the exact prompt it always had.
 */
export function ciFailureSection(failures: readonly TCiFailure[]): string {
	const body = renderCiFailures(failures)
	if (!body) return ""
	return (
		"CI IS FAILING ON THIS PR. These are the actual failures, read from GitHub:\n\n" +
		`${body}\n\n` +
		"Fix the CAUSE of these failures, in the code. Rules:\n" +
		"- Make the failing job pass. Do not work around it.\n" +
		"- Do NOT delete or skip tests, do NOT loosen assertions, and do NOT edit\n" +
		"  workflow files or CI configuration to make a failure disappear.\n" +
		"- If a failure is genuinely unrelated to this PR (a broken base branch, a\n" +
		"  flaky upstream), say so in your final message and change nothing for it.\n" +
		"- This is a FRESH CLONE: dependencies are NOT installed, so a test command\n" +
		"  will fail to even start until you run the project's install step. Install\n" +
		"  only if you need to reproduce the failure, and remember that installing\n" +
		"  does not modify tracked files.\n" +
		"- If you cannot reproduce it here, still fix what the annotation shows. Say\n" +
		"  in your final message what you changed and what you could not verify.\n\n"
	)
}

/**
 * Toolchain pin guards — port of `scripts/pr-queue-worker.py` lines 503-520
 * (`TOOLCHAIN_PINS`), 523-541 (`toolchain_pin_violation`) and 544-561
 * (`close_toolchain_pr`).
 *
 * The toolchain in `asepharyana/nextjs-template` is pinned EXACTLY: a specific
 * version in `package.json`, an `ignore` rule in `.github/dependabot.yml`, and
 * branch protection. The vendored Aceternity components and the CI stack are
 * validated against that one major. So a dependabot PR that moves a pinned
 * package to a different major is a policy violation no matter what CI says,
 * and the worker closes it immediately — before any review trigger, AI fix or
 * CI wait burns tokens on a PR whose fate is already decided.
 *
 * `TOOLCHAIN_PINS` IS A POLICY TABLE, NOT CONFIGURATION. It is transcribed
 * package for package from Python lines 510-520, and it is deliberately not
 * read from the environment: a policy that an env var can silently switch off
 * is not a policy. Changing a pin is a code change, on purpose.
 */

import type { CloseResult } from "./ci.ts"
import type { GhClient } from "./scan.ts"

/**
 * Python `TOOLCHAIN_PINS` (lines 510-520), byte-for-byte.
 * `repo full name -> { package -> allowed major }`.
 */
export const TOOLCHAIN_PINS: Record<string, Record<string, number>> = {
	"asepharyana/nextjs-template": {
		typescript: 6,
		eslint: 9,
		"eslint-config-next": 16,
		"eslint-plugin-react": 7,
		"@tsparticles/react": 3,
		"@tsparticles/engine": 3,
		"@tsparticles/slim": 3,
	},
}

/**
 * Python line 531, anchored at the start (Python `re.match`).
 *
 * `deps(?:-dev)?` is what lets ONE pattern cover both Dependabot title forms —
 * `chore(deps):` and `chore(deps-dev):` — which is most of the traffic here
 * (eslint and typescript arrive as dev dependencies).
 *
 * The anchor matters: a title with a prefix ("Re-run: chore(deps): …") must NOT
 * match, or a re-run of an old title would be judged as if it were the current
 * one. `^` is the JS spelling of `re.match`.
 */
const BUMP_TITLE = /^chore\(deps(?:-dev)?\): bump ([^ ]+) from ([0-9.]+) to ([0-9.]+)/

/** Python's `(pkg, old_ver, new_ver)` tuple, as an array. */
export type PinViolation = [string, string, string]

/**
 * Python `toolchain_pin_violation(repo_full, title)` (lines 523-541).
 *
 * The lookup order is the Python's and is part of the contract: repo first (an
 * unpinned repo is never a violation, whatever its title says), then the title
 * shape, then the package. So a `chore(deps)` title for an unpinned package in a
 * pinned repo is ignored, exactly as in Python.
 *
 * DIVERGENCE (deliberate, ruled by the controller): Python does
 * `int(new_ver.split(".")[0])`, which RAISES ValueError when the first segment
 * is empty — and a raise inside this call would propagate out of the PR loop
 * and abort the whole tick. Probed against the real Python: the title
 * `"chore(deps): bump typescript from 1.0.0 to .9"` raises
 * `ValueError: invalid literal for int() with base 10: ''`. Here a
 * non-finite major returns null instead.
 *
 * THIS FAILS OPEN, and that is safe rather than convenient: the `([0-9.]+)`
 * capture is what produces the major, and a Dependabot-generated title always
 * yields a numeric major, so the only inputs that reach the null branch are
 * hand-written or corrupt. A real pin violation (a real 5.x → 7.x bump)
 * can never be missed by it — it is not on that path.
 */
export function toolchainPinViolation(repo: string, title: string): PinViolation | null {
	const pins = TOOLCHAIN_PINS[repo]
	if (!pins) return null // Python lines 528-529
	const m = BUMP_TITLE.exec(String(title))
	if (!m) return null // Python line 532-533
	const [, pkg, oldVer, newVer] = m
	const allowedMajor = pins[pkg]
	if (allowedMajor === undefined) return null // Python lines 536-537
	const newMajor = toMajor(newVer)
	if (newMajor === null) return null // divergence, see above
	if (newMajor !== allowedMajor) return [pkg, oldVer, newVer]
	return null
}

/**
 * The major version of `ver`, or null when it is not one.
 *
 * This is deliberately NOT `Number(ver.split(".")[0])`. JavaScript coerces the
 * empty string to 0 and `"7."` to 7, both `Number.isFinite`, so a `isFinite`
 * guard would let an empty major through as major 0 — flagging a bump to
 * `.9` as a violation, where Python raises instead. Verified in Bun:
 * `Number("") === 0` and `Number.isFinite(0) === true`.
 *
 * Python's `int()` accepts only a non-empty run of digits (with optional
 * surrounding whitespace and sign), so a strict `^\d+$` reproduces its accept
 * set for the input this regex can capture: `([0-9.]+)` guarantees digits and
 * dots only, so a captured major is either digits or empty. An empty one is
 * the null case, and that is the only one.
 */
function toMajor(ver: string): number | null {
	const segment = ver.split(".")[0]
	if (!/^\d+$/.test(segment)) return null
	return Number(segment)
}

/**
 * Python `close_toolchain_pr(token, repo_full, pr_num, pkg, old_ver, new_ver)`
 * (lines 544-561).
 *
 * Same ordering contract as `closeStaleCiPr`: explanatory comment first
 * (best-effort — Python line 557 assigns its result and the call site at line
 * 1893 discards it with `_`), then the close PATCH. The comment is the only
 * record of why a dependabot PR was rejected, so it goes first even though
 * neither its success nor its failure changes the outcome.
 *
 * The body is transcribed verbatim from Python lines 547-555, arrow included.
 */
export async function closeToolchainPr(
	api: GhClient,
	token: string,
	repo: string,
	pr: number,
	pkg: string,
	oldVer: string,
	newVer: string,
): Promise<CloseResult> {
	const body =
		`⛔ Auto-closed by PR Queue Worker — **toolchain pin violation**.\n\n` +
		`\`${pkg}\` ${oldVer} → ${newVer} bumps a pinned toolchain package ` +
		`whose major must stay as declared in \`package.json\` (exact pin) and ` +
		`\`.github/dependabot.yml\` (\`ignore\` rule). The vendored Aceternity ` +
		`components and the CI stack are validated against this major only.\n\n` +
		`This PR is a policy violation — it will **not** be merged. ` +
		`If the pin needs changing, do it deliberately via a regular PR.`

	const comment = await api.request("POST", `/repos/${repo}/issues/${pr}/comments`, {
		token,
		json: { body },
	})
	const closed = await api.request("PATCH", `/repos/${repo}/pulls/${pr}`, {
		token,
		json: { state: "closed" },
	})
	return { status: closed.status, commentStatus: comment.status }
}

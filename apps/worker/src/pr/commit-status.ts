import type { CiResult } from "./ci.ts"
import type { GhClient } from "./scan.ts"

/**
 * Read GitHub's COMBINED COMMIT STATUS for a head.
 *
 * WHY THE PAT FALLBACK EXISTS — measured, not assumed. `GET /commits/{sha}/status`
 * needs the `statuses` permission, and the App installation on this fleet has
 * exactly `checks`, `issues`, `contents`, `metadata`, `pull_requests`. Probed with a
 * real installation token on MythEclipse/web1#24:
 *
 *   403  /repos/MythEclipse/web1/commits/<sha>/status
 *        x-accepted-github-permissions: statuses=read
 *   200  /repos/MythEclipse/web1/commits/<sha>/check-runs   (checks=read)
 *
 * So this call could NEVER succeed for the App, and the gate turned that into
 * `unknown` — which every caller treats as "do not merge, retry next tick". The
 * PR sat there forever and the report blamed a transient GitHub problem:
 *
 *   ⏳ CI unknown (⚠️ Commit status unavailable (HTTP 403)) — not spending an agent run
 *   ⏳ CI unknown — not merging on an unverified gate; will retry next tick
 *
 * It is not transient and no amount of retrying fixes it. The owner PAT carries the
 * `repo` scope, which covers commit statuses (verified: the same URL answers 200
 * with `state: pending, total_count: 0`), so it is used as a SECOND OPINION rather
 * than a retry: the App is asked first because it is the identity the rest of the
 * pipeline uses, and the PAT only fills a permission hole.
 *
 * The distinction the caller must keep: a non-200 from BOTH tokens is still
 * `unknown` — never green, never red. A 403 that the PAT turns into a real answer
 * is not an unknown at all; it is the answer.
 */
export async function checkCommitStatus(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
	/** Owner PAT, used only when the App is refused. `""` means "none available". */
	pat = "",
): Promise<{ count: number; blocked?: CiResult }> {
	const unknown = (msg: string) => ({ count: 0, blocked: { ok: false, unknown: true, msg } })
	const path = `/repos/${repo}/commits/${sha}/status`

	let { status, data } = await api.request("GET", path, { token })
	let usedPat = false
	// 401/403 is a PERMISSION answer, not a transient one: retrying the same token
	// changes nothing, and this is exactly the hole the PAT fills. A 5xx is left
	// alone — the PAT would hit the same incident, and reporting it as unreadable is
	// honest.
	if ((status === 401 || status === 403) && pat) {
		const viaPat = await api.request("GET", path, { token: pat })
		if (viaPat.status === 200) {
			status = viaPat.status
			data = viaPat.data
			usedPat = true
		} else {
			return unknown(
				`⚠️ Commit status unavailable (HTTP ${status} as the App, HTTP ${viaPat.status} as the owner PAT)` +
					(status === 403 ? " — the App needs `statuses: read`" : ""),
			)
		}
	}
	if (status !== 200) {
		// The message NAMES the missing permission when it is a 403. "HTTP 403" alone
		// sent the operator looking at the repo, the branch and the token's expiry —
		// none of which was the problem.
		return unknown(
			`⚠️ Commit status unavailable (HTTP ${status})` +
				(status === 403 ? " — the App needs `statuses: read`, and no owner PAT was available" : ""),
		)
	}
	// GITHUB'S COMBINED STATE HAS FOUR VALUES, NOT THREE.
	//
	// The docs list `error` alongside `pending | success | failure`: it means at
	// least one context reported `error` (a required check that could not run, a
	// third-party CI that failed to report). Excluding it from this allow-list
	// made every such head answer `unknown`, and an unknown gate refuses to merge
	// — so a PR whose CI had definitively ERRORED waited forever with a message
	// claiming the status was invalid. `error` is a FAILURE, not an unreadable
	// answer, and is handled by the red arm below.
	if (
		!data ||
		!Array.isArray(data.statuses) ||
		!["pending", "success", "failure", "error"].includes(data.state)
	) {
		return unknown("⚠️ Invalid combined commit status — not merging")
	}
	// `usedPat` is reported nowhere on the success path on purpose: it is a token
	// detail, not a fact about the PR, and a report line that changes depending on
	// which credential answered is noise. It exists so the code above can prove the
	// fallback happened; `noUnusedLocals` is off for this ported module.
	void usedPat
	const count = typeof data.total_count === "number" ? data.total_count : data.statuses.length
	if (count === 0) return { count: 0 } // GitHub reports pending when no contexts exist.
	if (data.state === "success") return { count }
	const names =
		data.statuses
			.filter((s: { state?: string }) => s.state !== "success")
			.slice(0, 3)
			.map((s: { context?: string }) => s.context)
			.join(", ") || "commit status contexts"
	return {
		count,
		blocked:
			data.state === "failure" || data.state === "error"
				? { ok: false, msg: `CI FAILED: ${names}` }
				: { ok: false, pending: true, msg: `CI pending: ${names}` },
	}
}

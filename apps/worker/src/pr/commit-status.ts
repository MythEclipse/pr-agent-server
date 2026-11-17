import type { CiResult } from "./ci.ts"
import type { GhClient } from "./scan.ts"

/** GitHub's combined state covers every context, including contexts past page one. */
export async function checkCommitStatus(
	api: GhClient,
	token: string,
	repo: string,
	sha: string,
): Promise<{ count: number; blocked?: CiResult }> {
	const { status, data } = await api.request("GET", `/repos/${repo}/commits/${sha}/status`, {
		token,
	})
	const unknown = (msg: string) => ({ count: 0, blocked: { ok: false, unknown: true, msg } })
	if (status !== 200) return unknown(`⚠️ Commit status unavailable (HTTP ${status})`)
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

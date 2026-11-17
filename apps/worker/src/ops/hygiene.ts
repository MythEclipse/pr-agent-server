// Branch and PR hygiene for the branches this worker owns.
//
// WHY IT IS NEEDED. Every vulnerability plan pushes a branch named
// `fix/vuln-<package>-<version>-<manifest hash>`. Three things follow from that,
// and nothing was cleaning up any of them:
//
//   1. A PR that a human closes — or that GitHub closes when the base branch
//      moves past it — leaves the BRANCH behind forever. Measured on the fleet
//      after two days of runs: branches with no PR, one per abandoned plan.
//   2. A superseded plan keeps its PR open. When the patched version moves (a new
//      advisory, or the tool now reaches a newer patch) the branch name changes,
//      so a second PR appears next to the first and BOTH claim to fix the same
//      package. The older one is not wrong, it is merely superseded — and two
//      green PRs for one advisory is how an operator merges the wrong one.
//   3. Merged branches are never deleted, so the branch list stops being a list
//      of work in progress.
//
// ONLY THE PREFIX IS EVER TOUCHED. A branch or PR that this worker did not name
// is invisible to it: `fix/vuln-` is the whole permission model, and it is why
// this can run unattended.

import type { GhClient } from "../pr/scan.ts"

export type HygieneDeps = {
	api: GhClient
	token: string
	repos: string[]
	dry: boolean
	log: (line: string) => void
	/** The branch prefix this worker owns. */
	prefix?: string
}

export type HygieneSummary = {
	closed: number
	deleted: number
	lines: string[]
}

type OpenPr = { number: number; ref: string; sha: string; title: string; createdAt: string }

/**
 * The package a bump PR is about, from the title this worker writes
 * (`fix(deps): bump <pkg> to <version> …`).
 *
 * Null when the title does not match — a PR that merely happens to be on a
 * `fix/vuln-` branch is not something to reason about, so it is left alone.
 */
export function packageFromTitle(title: string): string | null {
	const match = /bump (\S+) to (\S+)/.exec(title)
	return match?.[1] ?? null
}

/**
 * Pick the PRs that a newer PR for the same package has superseded.
 *
 * Newest wins, by creation time, because a newer plan was computed from a newer
 * advisory set. Returns the ones to close, never the winner.
 */
export function supersededPrs(prs: readonly OpenPr[]): OpenPr[] {
	const byPackage = new Map<string, OpenPr[]>()
	for (const pr of prs) {
		const pkg = packageFromTitle(pr.title)
		if (pkg === null) continue
		const list = byPackage.get(pkg) ?? []
		list.push(pr)
		byPackage.set(pkg, list)
	}
	const losers: OpenPr[] = []
	for (const list of byPackage.values()) {
		if (list.length < 2) continue
		const sorted = [...list].sort(
			(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number,
		)
		losers.push(...sorted.slice(1))
	}
	return losers
}

/**
 * Close the superseded PRs and delete branches that have no PR left.
 *
 * The order matters: closing first means a branch whose only PR was superseded is
 * deleted in the SAME run rather than the next one, so a single pass converges.
 */
export async function runHygiene(deps: HygieneDeps): Promise<HygieneSummary> {
	const prefix = deps.prefix ?? "fix/vuln-"
	const lines: string[] = []
	let closed = 0
	let deleted = 0

	for (const repo of deps.repos) {
		const pulls = await deps.api.request("GET", `/repos/${repo}/pulls?state=open&per_page=100`, {
			token: deps.token,
		})
		if (pulls.status !== 200 || !Array.isArray(pulls.data)) {
			lines.push(`⚠️  ${repo}: open PRs unreadable (HTTP ${pulls.status}) — left alone`)
			continue
		}

		const owned: OpenPr[] = (pulls.data as Record<string, unknown>[])
			.filter((pr) =>
				String((pr.head as Record<string, unknown> | undefined)?.ref ?? "").startsWith(prefix),
			)
			.map((pr) => ({
				number: Number(pr.number),
				ref: String((pr.head as Record<string, unknown>).ref ?? ""),
				sha: String((pr.head as Record<string, unknown>).sha ?? ""),
				title: String(pr.title ?? ""),
				createdAt: String(pr.created_at ?? ""),
			}))

		for (const loser of supersededPrs(owned)) {
			if (deps.dry) {
				lines.push(`DRY ${repo}: would close #${loser.number} (${loser.ref}) — superseded`)
				closed += 1
				continue
			}
			const commented = await deps.api.request(
				"POST",
				`/repos/${repo}/issues/${loser.number}/comments`,
				{
					token: deps.token,
					json: {
						body:
							"Superseded by a newer fix PR for the same package, which was computed from the " +
							"current advisory. Closing this one so there is a single branch to review.",
					},
				},
			)
			const res = await deps.api.request("PATCH", `/repos/${repo}/pulls/${loser.number}`, {
				token: deps.token,
				json: { state: "closed" },
			})
			if (res.status === 200) {
				closed += 1
				lines.push(
					`🧹 ${repo}: closed #${loser.number} as superseded` +
						(commented.status >= 400 ? ` (comment failed: HTTP ${commented.status})` : ""),
				)
			} else {
				lines.push(`⚠️  ${repo}: could not close #${loser.number} (HTTP ${res.status})`)
			}
		}

		// Re-read after closing, so a branch whose PR this run just closed is
		// deleted now instead of in the next pass.
		const after = await deps.api.request("GET", `/repos/${repo}/pulls?state=open&per_page=100`, {
			token: deps.token,
		})
		const stillOpen = new Set<string>(
			Array.isArray(after.data)
				? (after.data as Record<string, unknown>[]).map((pr) =>
						String((pr.head as Record<string, unknown> | undefined)?.ref ?? ""),
					)
				: owned.map((pr) => pr.ref),
		)

		const branches = await deps.api.request("GET", `/repos/${repo}/branches?per_page=100`, {
			token: deps.token,
		})
		if (branches.status !== 200 || !Array.isArray(branches.data)) {
			lines.push(`⚠️  ${repo}: branches unreadable (HTTP ${branches.status}) — left alone`)
			continue
		}
		for (const branch of branches.data as Record<string, unknown>[]) {
			const name = String(branch.name ?? "")
			if (!name.startsWith(prefix)) continue
			if (stillOpen.has(name)) continue
			if (deps.dry) {
				lines.push(`DRY ${repo}: would delete branch \`${name}\` (no open PR)`)
				deleted += 1
				continue
			}
			const res = await deps.api.request("DELETE", `/repos/${repo}/git/refs/heads/${name}`, {
				token: deps.token,
			})
			// 204 is the delete; 422 means the ref moved under us, which the next run
			// will pick up. Both leave the repo in a state the loop can live with.
			if (res.status === 204 || res.status === 422) {
				deleted += 1
				lines.push(`🧹 ${repo}: deleted branch \`${name}\` (no open PR)`)
			} else {
				lines.push(`⚠️  ${repo}: could not delete \`${name}\` (HTTP ${res.status})`)
			}
		}
	}

	return { closed, deleted, lines }
}

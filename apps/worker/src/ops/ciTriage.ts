// Triage the red CI on the PRs this worker opened.
//
// THE GAP. The worker opens a fix PR, waits for CI, and merges when it is green
// (`pr/merge.ts`). When CI is RED nothing happens at all: the PR sits there with
// a red X, no comment, no retry, and — because the branch is deterministic — the
// next nightly run sees "already open as PR #N" and moves on. Measured on the
// fleet: fix PRs left red for a day, with no signal beyond the X itself.
//
// TWO OUTCOMES, and telling them apart is the whole job:
//
//   FLAKY — the failure text carries a transport-shaped symptom (a timeout, a
//   reset connection, a 502/503 from a registry, "context deadline exceeded").
//   Those are re-run ONCE. A second red after a rerun is treated as real, so a
//   genuinely broken change cannot be retried into a green by luck.
//
//   REAL — everything else. The worker posts ONE comment naming the failing check
//   and the last line of its log, so the person opening the PR does not have to
//   click through six tabs to find out what broke.
//
// The comment is deduplicated by head SHA (`<!-- pr-agent:ci-triage:<sha> -->`),
// so a re-run of this lane does not stack identical comments on the same commit.

import type { GhClient } from "../pr/scan.ts"

export type TriageDeps = {
	api: GhClient
	token: string
	repos: string[]
	dry: boolean
	log: (line: string) => void
	prefix?: string
}

export type TriageSummary = {
	rerun: number
	commented: number
	lines: string[]
}

/** The transport-shaped symptoms worth one more try. */
const FLAKY =
	/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|502|503|504|context deadline exceeded|temporarily unavailable|rate limit/i

/**
 * Does this failure look like the infrastructure rather than the change?
 *
 * Exported for the test: the classification IS the behaviour, and reaching it
 * through `runTriage` would need a fully stubbed GitHub client.
 */
export function looksFlaky(text: string): boolean {
	return FLAKY.test(text)
}

/** The workflow run id out of a check run's `details_url`. */
export function runIdFromDetailsUrl(url: string): number | null {
	const match = /\/actions\/runs\/(\d+)/.exec(url)
	return match?.[1] ? Number(match[1]) : null
}

type CheckRun = {
	name?: string
	conclusion?: string | null
	details_url?: string
	output?: { title?: string; summary?: string; text?: string }
}

/**
 * One pass over the fleet.
 *
 * Only PRs on a branch this worker owns are touched, same permission model as
 * `hygiene.ts`: the prefix is the boundary.
 */
export async function runTriage(deps: TriageDeps): Promise<TriageSummary> {
	const prefix = deps.prefix ?? "fix/vuln-"
	const lines: string[] = []
	let rerun = 0
	let commented = 0

	for (const repo of deps.repos) {
		const pulls = await deps.api.request("GET", `/repos/${repo}/pulls?state=open&per_page=100`, {
			token: deps.token,
		})
		if (pulls.status !== 200 || !Array.isArray(pulls.data)) {
			lines.push(`⚠️  ${repo}: open PRs unreadable (HTTP ${pulls.status}) — left alone`)
			continue
		}

		for (const pr of pulls.data as Record<string, unknown>[]) {
			const head = (pr.head ?? {}) as Record<string, unknown>
			const ref = String(head.ref ?? "")
			if (!ref.startsWith(prefix)) continue
			const sha = String(head.sha ?? "")
			const number = Number(pr.number)

			const checks = await deps.api.request(
				"GET",
				`/repos/${repo}/commits/${sha}/check-runs?per_page=100`,
				{
					token: deps.token,
				},
			)
			if (checks.status !== 200 || !Array.isArray(checks.data?.check_runs)) {
				lines.push(`⚠️  ${repo}#${number}: check runs unreadable (HTTP ${checks.status})`)
				continue
			}

			const failed = (checks.data.check_runs as CheckRun[]).filter(
				(check) => check.conclusion === "failure" || check.conclusion === "timed_out",
			)
			if (failed.length === 0) continue

			const text = failed
				.map(
					(check) =>
						`${check.name ?? ""} ${check.output?.title ?? ""} ${check.output?.summary ?? ""}`,
				)
				.join(" ")

			if (looksFlaky(text)) {
				const runIds = [
					...new Set(
						failed
							.map((check) => runIdFromDetailsUrl(String(check.details_url ?? "")))
							.filter((id): id is number => id !== null),
					),
				]
				if (runIds.length === 0) {
					lines.push(`⚠️  ${repo}#${number}: flaky-looking failure but no workflow run to re-run`)
					continue
				}
				if (deps.dry) {
					lines.push(`DRY ${repo}#${number}: would re-run ${runIds.length} workflow run(s)`)
					rerun += 1
					continue
				}
				for (const id of runIds) {
					const res = await deps.api.request(
						"POST",
						`/repos/${repo}/actions/runs/${id}/rerun-failed-jobs`,
						{
							token: deps.token,
						},
					)
					if (res.status === 201 || res.status === 200 || res.status === 204) {
						rerun += 1
						lines.push(
							`🔁 ${repo}#${number}: re-ran failed jobs of run ${id} (transport-shaped failure)`,
						)
					} else {
						lines.push(`⚠️  ${repo}#${number}: could not re-run ${id} (HTTP ${res.status})`)
					}
				}
				continue
			}

			// REAL: one comment per head SHA, naming what broke.
			const marker = `<!-- pr-agent:ci-triage:${sha} -->`
			const comments = await deps.api.request(
				"GET",
				`/repos/${repo}/issues/${number}/comments?per_page=100`,
				{
					token: deps.token,
				},
			)
			const already = Array.isArray(comments.data)
				? (comments.data as Record<string, unknown>[]).some((c) =>
						String(c.body ?? "").includes(marker),
					)
				: false
			if (already) continue

			const body = [
				marker,
				"### CI is red on this fix",
				"",
				...failed.map(
					(check) =>
						`- **${check.name ?? "check"}** — \`${check.conclusion}\`${check.details_url ? ` ([log](${check.details_url}))` : ""}`,
				),
				"",
				"The failure does not look transport-shaped, so it was not re-run automatically: " +
					"something in the change (or the repository) has to be fixed first.",
			].join("\n")

			if (deps.dry) {
				lines.push(`DRY ${repo}#${number}: would comment on ${failed.length} failing check(s)`)
				commented += 1
				continue
			}
			const res = await deps.api.request("POST", `/repos/${repo}/issues/${number}/comments`, {
				token: deps.token,
				json: { body },
			})
			if (res.status === 201 || res.status === 200) {
				commented += 1
				lines.push(
					`💬 ${repo}#${number}: commented on ${failed.map((c) => c.name ?? "check").join(", ")}`,
				)
			} else {
				lines.push(`⚠️  ${repo}#${number}: could not comment (HTTP ${res.status})`)
			}
		}
	}

	return { rerun, commented, lines }
}

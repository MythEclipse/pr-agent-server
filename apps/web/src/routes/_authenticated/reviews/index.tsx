// Review history: the list every dashboard visit lands on.
//
// A feature as a single file (skill §3.1) — it is still small enough that
// promoting it to a folder with _components/ would be churn.

import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { Badge, STATUS_TONE } from "#/components/ui/badge.tsx"
import { Button } from "#/components/ui/button.tsx"
import { Card, CardContent } from "#/components/ui/card.tsx"
import { Input } from "#/components/ui/input.tsx"
import { formatWhen } from "#/libs/format-when.ts"
import { orpc } from "#/libs/orpc/client.ts"
import { reviewKeys } from "./-apis/review-keys.ts"

export const Route = createFileRoute("/_authenticated/reviews/")({
	validateSearch: (search: Record<string, unknown>): { status?: string } => ({
		status: typeof search.status === "string" ? search.status : undefined,
	}),
	component: ReviewsPage,
})

const STATUSES = ["", "success", "failed", "running", "queued"] as const
const PAGE_SIZE = 25

/**
 * How often the live counters are re-read.
 *
 * The header is the only place `queued` and `running` are visible as NUMBERS, so
 * it has to be able to notice a review that starts or finishes on its own. Ten
 * seconds against one `GROUP BY` is cheap; the alternative — a header that only
 * moves when the operator clicks Refresh — is what made the old numbers look
 * frozen and wrong.
 */
const COUNTS_POLL_MS = 10_000

/**
 * How often the LIST is re-read, and only while there is live work.
 *
 * A row used to sit on `queued` until somebody pressed Refresh, because the
 * transition to `running`/`success` happened server-side after the fetch. The
 * status column was therefore correct at fetch time and wrong from then on,
 * which reads as a broken queue rather than a stale page.
 */
const LIVE_POLL_MS = 4_000

function ReviewsPage() {
	const navigate = useNavigate()
	const { status } = Route.useSearch()
	const [repoFilter, setRepoFilter] = useState("")
	const [page, setPage] = useState(0)

	const input = {
		status: (status || undefined) as never,
		repo: repoFilter || undefined,
		limit: PAGE_SIZE,
		offset: page * PAGE_SIZE,
	}

	// Per-status counts, from the same table the list reads, so the header and
	// the rows cannot disagree.
	const { data: counts } = useSuspenseQuery(
		orpc.review.counts.queryOptions({
			queryKey: reviewKeys.counts(),
			refetchInterval: COUNTS_POLL_MS,
		}),
	)
	const live = (counts?.queued ?? 0) + (counts?.running ?? 0)

	const { data, isFetching, refetch } = useSuspenseQuery(
		orpc.review.list.queryOptions({
			input,
			queryKey: reviewKeys.list(input),
			// Only while something is actually in flight: an idle history page
			// must not poll a database every 4 seconds forever.
			refetchInterval: live > 0 ? LIVE_POLL_MS : false,
		}),
	)

	// A query refetch, NOT `window.location.reload()`. A full reload re-downloads
	// the SPA, drops the repo filter the operator was mid-way through typing, resets
	// the page back to 1 and loses scroll position — for a button whose whole job is
	// "fetch the same view again".
	const onRefresh = (): void => {
		void refetch()
	}

	const rows = data?.rows ?? []
	const total = data?.total ?? 0

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-end justify-between">
				<div>
					<h1 className="text-xl font-semibold">Review history</h1>
					<p className="text-sm text-slate-500">
						{total} review{total === 1 ? "" : "s"}
						{/* The live counts, which used to be nowhere: the list can only
						    show one status at a time, so "2 running, 3 queued" had no
						    surface at all — and `running` could never have shown a row
						    because nothing wrote that status. */}
						{live > 0 ? (
							<span className="ml-2 text-slate-700">
								· {counts?.running ?? 0} running · {counts?.queued ?? 0} queued
							</span>
						) : null}
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
					{isFetching ? "Refreshing…" : "Refresh"}
				</Button>
			</header>

			<div className="flex flex-wrap items-center gap-2">
				<Input
					placeholder="filter by repo"
					value={repoFilter}
					onChange={(e) => {
						setRepoFilter(e.target.value)
						setPage(0)
					}}
					className="max-w-xs"
				/>
				{STATUSES.map((s) => (
					<Button
						key={s || "all"}
						variant={status === s ? "default" : "outline"}
						size="sm"
						onClick={() => {
							void navigate({ to: "/reviews", search: s ? { status: s } : {} })
							setPage(0)
						}}
					>
						{s || "all"}
						{/* The count beside each filter, so a status with no rows says so
						    instead of looking like a filter that does not work. */}
						{s && counts ? (
							<span className="ml-1.5 tabular-nums opacity-60">{counts[s]}</span>
						) : null}
					</Button>
				))}
			</div>

			<Card>
				<CardContent className="p-0">
					<table className="w-full text-sm">
						<thead className="border-b bg-slate-50 text-left text-xs tracking-wide text-slate-500 uppercase">
							<tr>
								<th className="px-5 py-2 font-medium">PR</th>
								<th className="px-5 py-2 font-medium">Status</th>
								<th className="px-5 py-2 font-medium">Score</th>
								<th className="px-5 py-2 font-medium">Model</th>
								<th className="px-5 py-2 font-medium">When</th>
							</tr>
						</thead>
						<tbody>
							{rows.length === 0 ? (
								<tr>
									<td className="px-5 py-8 text-center text-slate-500" colSpan={5}>
										<p>No reviews recorded yet.</p>
										{/* History is written when a review RUNS, so every job
										    completed before that was added left no row. Saying only
										    "No reviews yet" over an empty table reads as data loss to
										    an operator who knows reviews have happened — name the
										    reason here instead of leaving them to guess. */}
										<p className="mt-1 text-xs">
											Reviews are recorded as they run. Anything reviewed before this page existed
											has no history to show — open a PR to start it.
										</p>
									</td>
								</tr>
							) : (
								rows.map((row) => (
									<tr key={row.id} className="border-b last:border-0 hover:bg-slate-50">
										<td className="px-5 py-3">
											<Link
												to="/reviews/$reviewId"
												params={{ reviewId: String(row.id) }}
												className="font-medium hover:underline"
											>
												{row.owner}/{row.repo} #{row.pr}
											</Link>
											<span className="ml-2 text-xs text-slate-400">{row.kind}</span>
										</td>
										<td className="px-5 py-3">
											<Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</Badge>
										</td>
										<td className="px-5 py-3 tabular-nums">{row.score ?? "—"}</td>
										<td className="px-5 py-3 text-slate-600">
											{/* Served model in parens when the gateway substituted it. */}
											{row.model ?? "—"}
											{row.servedModel && row.servedModel !== row.model ? (
												<span className="text-amber-600"> ({row.servedModel})</span>
											) : null}
										</td>
										<td className="px-5 py-3 text-slate-600">{formatWhen(row.createdAt)}</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</CardContent>
			</Card>

			{total > PAGE_SIZE ? (
				<div className="flex items-center justify-end gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={page === 0}
						onClick={() => setPage((p) => p - 1)}
					>
						Previous
					</Button>
					<span className="text-sm text-slate-500">
						Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}
					</span>
					<Button
						variant="outline"
						size="sm"
						disabled={(page + 1) * PAGE_SIZE >= total}
						onClick={() => setPage((p) => p + 1)}
					>
						Next
					</Button>
				</div>
			) : null}
		</div>
	)
}

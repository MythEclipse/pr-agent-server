// Review history: the list every dashboard visit lands on.
//
// A feature as a single file (skill §3.1) — it is still small enough that
// promoting it to a folder with _components/ would be churn.

import { useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { useSuspenseQuery } from "@tanstack/react-query"
import { orpc } from "#/libs/orpc/client.ts"
import { Badge, STATUS_TONE } from "#/components/ui/badge.tsx"
import { Button } from "#/components/ui/button.tsx"
import { Card, CardContent } from "#/components/ui/card.tsx"
import { Input } from "#/components/ui/input.tsx"
import { reviewKeys } from "./_apis/review-keys.ts"

export const Route = createFileRoute("/_authenticated/reviews/")({
	validateSearch: (search: Record<string, unknown>): { status?: string } => ({
		status: typeof search.status === "string" ? search.status : undefined,
	}),
	component: ReviewsPage,
})

const STATUSES = ["", "success", "failed", "running", "queued"] as const
const PAGE_SIZE = 25

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

	const { data } = useSuspenseQuery(
		orpc.review.list.queryOptions({ input, queryKey: reviewKeys.list(input) }),
	)

	const rows = data?.rows ?? []
	const total = data?.total ?? 0

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-end justify-between">
				<div>
					<h1 className="text-xl font-semibold">Review history</h1>
					<p className="text-sm text-slate-500">
						{total} review{total === 1 ? "" : "s"}
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => window.location.reload()}>
					Refresh
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
										No reviews yet.
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
										<td className="px-5 py-3 text-slate-600">{row.model ?? "—"}</td>
										<td className="px-5 py-3 text-slate-600">
											{row.createdAt
												? new Date(row.createdAt).toISOString().slice(0, 16).replace("T", " ")
												: "—"}
										</td>
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
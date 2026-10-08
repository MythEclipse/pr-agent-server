// One review in full: the metadata the pipeline recorded plus the markdown it
// published to GitHub, so an operator can see what the model said without
// opening the PR.

import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Badge, STATUS_TONE } from "#/components/ui/badge.tsx"
import { Button } from "#/components/ui/button.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card.tsx"
import { orpc } from "#/libs/orpc/client.ts"
import { reviewKeys } from "./_apis/review-keys.ts"

export const Route = createFileRoute("/_authenticated/reviews/$reviewId")({
	component: ReviewDetail,
})

function ReviewDetail() {
	const { reviewId } = Route.useParams()
	const id = Number(reviewId)

	const { data: row } = useSuspenseQuery(
		orpc.review.get.queryOptions({ input: { id }, queryKey: reviewKeys.detail(id) }),
	)

	const started = row.startedAt ? new Date(row.startedAt) : null
	const finished = row.finishedAt ? new Date(row.finishedAt) : null

	return (
		<div className="flex flex-col gap-4">
			<header className="flex items-center justify-between">
				<div>
					<Link to="/reviews" className="text-sm text-slate-500 hover:text-slate-900">
						← Review history
					</Link>
					<h1 className="text-xl font-semibold">
						{row.owner}/{row.repo} #{row.pr}
					</h1>
				</div>
				<Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</Badge>
			</header>

			<Card>
				<CardHeader>
					<CardTitle>Metadata</CardTitle>
				</CardHeader>
				<CardContent>
					<dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
						<div>
							<dt className="text-slate-500">Kind</dt>
							<dd>{row.kind}</dd>
						</div>
						<div>
							<dt className="text-slate-500">Score</dt>
							<dd className="tabular-nums">{row.score ?? "—"}</dd>
						</div>
						<div>
							<dt className="text-slate-500">Model</dt>
							<dd>{row.model}</dd>
						</div>
						<div>
							<dt className="text-slate-500">Head SHA</dt>
							<dd className="truncate font-mono text-xs">{row.headSha?.slice(0, 12) ?? "—"}</dd>
						</div>
						<div>
							<dt className="text-slate-500">Started</dt>
							<dd>{started ? started.toISOString().slice(0, 16).replace("T", " ") : "—"}</dd>
						</div>
						<div>
							<dt className="text-slate-500">Finished</dt>
							<dd>{finished ? finished.toISOString().slice(0, 16).replace("T", " ") : "—"}</dd>
						</div>
						<div>
							<dt className="text-slate-500">GitHub comment</dt>
							<dd className="truncate font-mono text-xs">{row.githubCommentId ?? "—"}</dd>
						</div>
						<div>
							<dt className="text-slate-500">Duration</dt>
							<dd>
								{started && finished
									? `${Math.round((finished.getTime() - started.getTime()) / 1000)}s`
									: "—"}
							</dd>
						</div>
					</dl>
				</CardContent>
			</Card>

			{row.error ? (
				<Card className="border-red-200">
					<CardHeader>
						<CardTitle className="text-red-700">Error</CardTitle>
					</CardHeader>
					<CardContent>
						<pre className="overflow-x-auto text-sm whitespace-pre-wrap text-red-700">
							{row.error}
						</pre>
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>Review</CardTitle>
				</CardHeader>
				<CardContent>
					{row.markdown ? (
						<pre className="overflow-x-auto text-sm whitespace-pre-wrap">{row.markdown}</pre>
					) : (
						<p className="text-sm text-slate-500">No review body recorded.</p>
					)}
				</CardContent>
			</Card>

			<div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						window.open(
							`https://github.com/${row.owner}/${row.repo}/pull/${row.pr}`,
							"_blank",
							"noopener",
						)
					}}
				>
					Open PR on GitHub
				</Button>
			</div>
		</div>
	)
}

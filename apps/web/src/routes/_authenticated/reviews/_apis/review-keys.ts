// Query key factory (skill §3.8 rule 1): never inline a query key.
//
// Shape: all -> lists -> list(params) -> details -> detail(id), so
// `reviewKeys.all` invalidates every review query at once.

export interface TListReviewParams {
	owner?: string
	repo?: string
	pr?: number
	status?: "queued" | "running" | "success" | "failed"
	kind?: "review" | "describe" | "improve"
	limit?: number
	offset?: number
}

export const reviewKeys = {
	all: ["reviews"] as const,
	lists: () => [...reviewKeys.all, "list"] as const,
	list: (params?: TListReviewParams) => [...reviewKeys.lists(), params ?? {}] as const,
	details: () => [...reviewKeys.all, "detail"] as const,
	detail: (id: number) => [...reviewKeys.details(), id] as const,
}

export const queueKeys = {
	all: ["queue"] as const,
	stats: () => [...queueKeys.all, "stats"] as const,
}
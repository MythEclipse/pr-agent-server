// The root route. Carries the query client on the router context so every
// child can reach it, and renders the document shell (skill §3.1).

import type { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router"

export interface IRouterContext {
	queryClient: QueryClient
}

export const Route = createRootRouteWithContext<IRouterContext>()({
	component: RootComponent,
	notFoundComponent: () => (
		<div className="flex min-h-screen items-center justify-center text-slate-600">Not found</div>
	),
})

function RootComponent() {
	return (
		<div className="min-h-screen bg-slate-50 text-slate-900 antialiased">
			<Outlet />
		</div>
	)
}

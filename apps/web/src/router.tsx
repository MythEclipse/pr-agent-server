// Router + query client wiring.
//
// `getQueryClient` returns a fresh client per request on the server and a
// singleton in the browser, so a client is never shared across concurrent
// requests during SSR (skill §3.4).

import { QueryClient } from "@tanstack/react-query"
import { createRouter as createTanstackRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen.ts"

let browserQueryClient: QueryClient | undefined

export function getQueryClient(): QueryClient {
	if (typeof window === "undefined") return new QueryClient()
	browserQueryClient ??= new QueryClient()
	return browserQueryClient
}

export function createRouter() {
	return createTanstackRouter({
		routeTree,
		context: { queryClient: getQueryClient() },
		defaultPreload: "intent",
	})
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createRouter>
	}
}

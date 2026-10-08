// Authenticated layout: the guard for every review page lives here, so the
// dashboard's children only render for a signed-in operator (skill §3.1).
//
// The UX half of the authz pair. The authoritative half is adminProcedure on
// the oRPC side — this redirect is a convenience, never the enforcement.

import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { authClient } from "#/libs/auth/client.ts"
import { SignOutButton } from "./_authenticated/_components/sign-out-button.tsx"

export const Route = createFileRoute("/_authenticated")({
	beforeLoad: async () => {
		const session = await authClient.getSession()
		if (!session.data?.user) throw redirect({ to: "/login" })
		return { user: session.data.user }
	},
	component: AuthenticatedLayout,
})

function AuthenticatedLayout() {
	return (
		<div className="min-h-screen">
			<header className="border-b bg-white">
				<div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
					<nav className="flex items-center gap-4 text-sm">
						<span className="font-semibold">PR-Agent</span>
						<a href="/reviews" className="text-slate-600 hover:text-slate-900">
							Reviews
						</a>
					</nav>
					<SignOutButton />
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-6 py-8">
				<Outlet />
			</main>
		</div>
	)
}

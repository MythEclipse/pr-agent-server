// Public layout: the login page renders inside this. The `.tsx` file is the
// layout component and `_public/` holds its children — both must exist for the
// guard to work (skill §3.1).

import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/_public")({
	component: PublicLayout,
})

function PublicLayout() {
	return (
		<div className="flex min-h-screen items-center justify-center p-6">
			<Outlet />
		</div>
	)
}

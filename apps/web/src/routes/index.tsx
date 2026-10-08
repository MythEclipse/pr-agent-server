// The index route: send a signed-in operator to the review history, and
// anyone else to the login page.

import { createFileRoute, redirect } from "@tanstack/react-router"
import { authClient } from "#/libs/auth/client.ts"

export const Route = createFileRoute("/")({
	beforeLoad: async () => {
		const session = await authClient.getSession()
		throw redirect({ to: session.data?.user ? "/reviews" : "/login" })
	},
})

// The index route: send a signed-in operator to the review history, and
// anyone else to the login page.
//
// IT MUST FORWARD `?error=`. better-auth's failure redirect is a 302 to
// `/?error=<code>` (measured: an OAuth `access_denied` lands on
// `/?error=access_denied`, and a bad state on `/?error=state_mismatch`). This
// route then redirected to a bare `/login`, dropping the query string — so a
// failed Google sign-in returned the user to a pristine login form with no
// explanation, indistinguishable from having clicked nothing at all. The login
// page reads `?error=` to show it; this is the hop that was losing it.

import { createFileRoute, redirect } from "@tanstack/react-router"
import { authClient } from "#/libs/auth/client.ts"

export const Route = createFileRoute("/")({
	validateSearch: (search: Record<string, unknown>): { error?: string } => ({
		error: typeof search.error === "string" ? search.error : undefined,
	}),
	beforeLoad: async ({ search }: { search: { error?: string } }) => {
		const session = await authClient.getSession()
		if (session.data?.user) throw redirect({ to: "/reviews" })
		throw redirect({
			to: "/login",
			// Only when present, so the URL stays clean on a normal visit.
			...(search.error ? { search: { error: search.error } } : {}),
		})
	},
})

// The login page. Access is by INVITATION ONLY: this form never offers to create
// an account, because better-auth's role field is `input: false` and a signup
// path would have nowhere to put a role.
//
// Two ways in:
//   - email + password, for the admin account seeded at deploy time;
//   - Google, for any address on the server's AUTH_ALLOWED_EMAILS list. Google
//     authenticates anybody, so the allowlist — not this page — is the boundary.

import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { Button } from "#/components/ui/button.tsx"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx"
import { Input } from "#/components/ui/input.tsx"
import { authClient } from "#/libs/auth/client.ts"

export const Route = createFileRoute("/_public/login")({
	/**
	 * `error` comes back from the OAuth callback as a query param, because the
	 * failure happens in a full-page redirect that the SPA cannot catch. Without
	 * reading it, a rejected Google sign-in would return the user to a login form
	 * with no explanation and look like nothing happened.
	 */
	validateSearch: (search: Record<string, unknown>): { error?: string } => ({
		error: typeof search.error === "string" ? search.error : undefined,
	}),
	component: LoginPage,
})

function LoginPage() {
	const navigate = useNavigate()
	const { error: callbackError } = Route.useSearch()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState(false)
	const [googlePending, setGooglePending] = useState(false)

	async function onSubmit(event: FormEvent) {
		event.preventDefault()
		setPending(true)
		setError(null)
		const result = await authClient.signIn.email({ email, password })
		setPending(false)
		if (result.error) {
			setError(result.error.message ?? "sign-in failed")
			return
		}
		await navigate({ to: "/reviews" })
	}

	async function onGoogle() {
		setGooglePending(true)
		setError(null)
		// This navigates away to Google, so there is nothing to reset on success —
		// but a failed start (provider not configured) must not leave a dead button.
		const result = await authClient.signIn.social({
			provider: "google",
			callbackURL: `${window.location.origin}/reviews`,
		})
		if (result?.error) {
			setError(result.error.message ?? "Google sign-in failed")
			setGooglePending(false)
		}
	}

	// The server's rejection message is shown verbatim: it is written to be safe
	// (it does not say whether the address exists, or who IS allowed).
	const shownError = error ?? callbackError ?? null

	return (
		<Card className="w-full max-w-sm">
			<CardHeader>
				<CardTitle>PR-Agent</CardTitle>
				<CardDescription>Sign in to the review history.</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<Button
					type="button"
					variant="outline"
					onClick={onGoogle}
					disabled={googlePending}
					className="w-full"
				>
					{googlePending ? "Redirecting…" : "Continue with Google"}
				</Button>

				<div className="flex items-center gap-3">
					<span className="h-px flex-1 bg-slate-200" />
					<span className="text-xs tracking-wide text-slate-400 uppercase">or</span>
					<span className="h-px flex-1 bg-slate-200" />
				</div>

				<form className="flex flex-col gap-3" onSubmit={onSubmit}>
					<Input
						type="email"
						autoComplete="username"
						placeholder="you@example.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
					/>
					<Input
						type="password"
						autoComplete="current-password"
						placeholder="••••••••"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						required
					/>
					{shownError ? <p className="text-sm text-red-600">{shownError}</p> : null}
					<Button type="submit" disabled={pending}>
						{pending ? "Signing in…" : "Sign in"}
					</Button>
				</form>
			</CardContent>
		</Card>
	)
}

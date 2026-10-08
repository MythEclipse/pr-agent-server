// The login page. One admin account, seeded once at deploy time; this form
// only proves who you are — it never offers to create an account, because
// better-auth's role field is `input: false` and a signup path would have
// nowhere to put a role.

import { useState, type FormEvent } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { authClient } from "#/libs/auth/client.ts"
import { Button } from "#/components/ui/button.tsx"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx"
import { Input } from "#/components/ui/input.tsx"

export const Route = createFileRoute("/_public/login")({
	component: LoginPage,
})

function LoginPage() {
	const navigate = useNavigate()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState(false)

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

	return (
		<Card className="w-full max-w-sm">
			<CardHeader>
				<CardTitle>PR-Agent</CardTitle>
				<CardDescription>Sign in to the review history.</CardDescription>
			</CardHeader>
			<CardContent>
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
					{error ? <p className="text-sm text-red-600">{error}</p> : null}
					<Button type="submit" disabled={pending}>
						{pending ? "Signing in…" : "Sign in"}
					</Button>
				</form>
			</CardContent>
		</Card>
	)
}
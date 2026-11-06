import { Button } from "#/components/ui/button.tsx"
import { authClient } from "#/libs/auth/client.ts"

export function SignOutButton() {
	return (
		<Button
			variant="outline"
			size="sm"
			onClick={async () => {
				await authClient.signOut()
				window.location.href = "/login"
			}}
		>
			Sign out
		</Button>
	)
}

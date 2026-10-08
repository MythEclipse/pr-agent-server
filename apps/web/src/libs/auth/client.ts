// The browser's better-auth client.
//
// Single-tenant, so this installs adminClient (for user administration) and
// NOT organizationClient — there is no org to administer. The base URL is
// same-origin in both dev (Vite proxies /api/auth) and prod (Hono serves the
// SPA and the API from one host), which keeps the session cookie first-party.

import { createAuthClient } from "better-auth/react"
import { adminClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
	baseURL: `${import.meta.env.VITE_API_URL ?? ""}/api/auth`,
	fetchOptions: { credentials: "include" },
	plugins: [adminClient()],
})

export const { signIn, signOut, useSession } = authClient
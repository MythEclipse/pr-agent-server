// The browser's better-auth client.
//
// Single-tenant, so this installs adminClient (for user administration) and
// NOT organizationClient — there is no org to administer.
//
// THE BASE URL MUST BE ABSOLUTE. It used to be `${VITE_API_URL ?? ""}/api/auth`,
// which in production — where VITE_API_URL is not set at build time — evaluated
// to the RELATIVE string `/api/auth`. better-auth 1.7.x validates its base URL
// with `new URL()` and throws `BetterAuthError: Invalid base URL: /api/auth` for
// anything without a scheme. That throw happens at MODULE EVALUATION, before
// React mounts, so the whole app died on import: the served HTML was fine, every
// asset returned 200, and the browser rendered a blank white page with an empty
// `<div id="root">`. Nothing appeared in the server logs, because no request
// ever failed.
//
// Reproduced against the installed 1.7.10 by calling `createAuthClient` directly:
//   baseURL "/api/auth"             -> THREW: Invalid base URL: /api/auth
//   baseURL "https://host/api/auth" -> OK
//
// So the origin is resolved at RUNTIME from `window.location.origin`. That keeps
// the cookie first-party and same-origin (the reason it was relative in the
// first place), works behind the Caddy/Cloudflare edge without baking a hostname
// into the bundle, and still honours VITE_API_URL for a split-origin deploy.

import { adminClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

/**
 * The API origin, always absolute.
 *
 * `VITE_API_URL` wins when set (a split-origin deploy). Otherwise it is the
 * page's own origin, which is what keeps cookies first-party in both dev (Vite
 * on :5173, proxying /api/auth) and production (Hono serving SPA + API from one
 * host).
 */
export function apiOrigin(): string {
	const configured = import.meta.env.VITE_API_URL
	if (configured) return configured.replace(/\/+$/, "")
	// `window` is absent during SSR/prerender. Falling back rather than throwing
	// matters: an exception here takes the whole bundle down, which is exactly
	// the white screen this function exists to prevent.
	if (typeof window === "undefined") return "http://localhost"
	return window.location.origin
}

export const authClient = createAuthClient({
	baseURL: `${apiOrigin()}/api/auth`,
	fetchOptions: { credentials: "include" },
	plugins: [adminClient()],
})

export const { signIn, signOut, useSession } = authClient

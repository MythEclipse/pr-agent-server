// The built dashboard must be able to BOOT, not merely be served.
//
// This exists because of a live white screen: https://pr-agent.asepharyana.my.id/
// answered 200 with correct HTML and every asset returned 200, yet the page was
// blank. The cause was a module-level throw in the browser bundle — better-auth
// 1.7.x rejects a relative base URL, and `src/libs/auth/client.ts` built one from
// `import.meta.env.VITE_API_URL ?? ""`, which is `""` in production. That threw
// during import, before React could mount, so `#root` stayed empty and no server
// log line was ever produced.
//
// No API test could see it: the server did everything right. No typecheck could
// see it either — `/api/auth` is a valid string. So this asserts the two properties
// that actually failed, statically, on the source (the pattern wiring.test.ts
// already uses for bugs that live BETWEEN modules):
//
//   1. no browser-facing client builds an API URL from a possibly-empty env var;
//   2. the origin helper returns something ABSOLUTE.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const webSrc = (rel: string): string =>
	readFileSync(join(import.meta.dirname, "..", "..", "web", "src", rel), "utf8")

/** The two clients that talk to the API from the browser. */
const BROWSER_CLIENTS = ["libs/auth/client.ts", "libs/orpc/client.ts"] as const

describe("browser API clients use an absolute origin", () => {
	for (const rel of BROWSER_CLIENTS) {
		test(`${rel} does not interpolate a possibly-empty VITE_API_URL into a URL`, () => {
			const src = webSrc(rel)
			// The exact shape that broke production: `${import.meta.env.VITE_API_URL ?? ""}/…`
			// interpolating the fallback directly yields a relative URL.
			expect(src).not.toMatch(/\$\{import\.meta\.env\.VITE_API_URL\s*\?\?\s*""\}/)
			// And it must route through the one helper that guarantees a scheme.
			expect(src).toContain("apiOrigin()")
		})
	}

	test("apiOrigin resolves the real origin at runtime, not at build time", () => {
		// A build-time constant cannot work here: the same artifact is served from
		// whatever host the deploy lands on, and VITE_API_URL is unset.
		const src = webSrc("libs/auth/client.ts")
		expect(src).toContain("window.location.origin")
		// Guards against a later "simplification" back to a bare relative path.
		expect(src).not.toMatch(/baseURL:\s*["'`]\/api\/auth/)
	})

	test("apiOrigin never returns a value without a scheme", () => {
		// Asserted on the SOURCE rather than by importing it: this file lives in the
		// web project, whose tsconfig carries the DOM + Vite `import.meta.env` types.
		// The API project has neither, so importing it here would fail typecheck for
		// a reason unrelated to the bug. The two branches that matter are both
		// visible statically: a configured VITE_API_URL is returned (absolute by
		// contract), and the fallback is `window.location.origin`.
		const src = webSrc("libs/auth/client.ts")
		expect(src).toMatch(/if \(configured\) return configured\.replace/)
		expect(src).toContain('if (typeof window === "undefined") return "http://localhost"')
		expect(src).toContain("return window.location.origin")
	})
})

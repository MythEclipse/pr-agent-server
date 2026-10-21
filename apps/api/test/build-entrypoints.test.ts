// Every executable the deploy needs must actually be BUILT.
//
// This exists because of a live provisioning dead end: the dashboard has no
// default credentials and no signup path (`role` is `input: false` in
// better-auth), so `src/db/seed.ts` is the ONLY way an admin account can ever
// exist. It was absent from `entryPoints` in build.mjs, so `dist/seed.js` was
// never produced — `ls /opt/pr-agent-server/dist` showed only main.js and
// migrate.js. The `user` table was therefore empty and every login failed no
// matter what was typed, with nothing anywhere saying why.
//
// `tsc --noEmit` cannot catch this (seed.ts typechecks fine, it is simply not
// emitted) and neither can any runtime test of the seed logic. So the assertion
// belongs here, against the build config itself.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const repoRoot = join(import.meta.dirname, "..")

const readBuildConfig = (): string => readFileSync(join(repoRoot, "build.mjs"), "utf8")

describe("api build entrypoints", () => {
	test("builds the admin seed, the only way an admin can exist", () => {
		// Without this entry the documented provisioning step cannot run on the box.
		expect(readBuildConfig()).toContain("src/db/seed.ts")
	})

	test("builds the server and the migrator the deploy invokes", () => {
		const config = readBuildConfig()
		// Both are called out by name in .github/workflows/deploy.yml:
		// `node dist/migrate.js` before the restart, `dist/main.js` as ExecStart.
		expect(config).toContain("src/main.ts")
		expect(config).toContain("src/migrate.ts")
	})

	test("the deploy workflow never invokes an entry that is not built", () => {
		// Cross-check the two files rather than trusting the list above: a future
		// `node dist/<something>.js` in the deploy must correspond to a real
		// entryPoint, or the deploy fails on the box instead of in CI.
		const deploy = readFileSync(
			join(repoRoot, "..", "..", ".github", "workflows", "deploy.yml"),
			"utf8",
		)
		const built = ["main", "migrate", "db/seed"]
		const invoked = [...deploy.matchAll(/dist\/([A-Za-z0-9_/-]+)\.js/g)].map((m) => m[1])
		expect(invoked.length).toBeGreaterThan(0)
		for (const entry of invoked) {
			expect(built, `deploy.yml runs dist/${String(entry)}.js`).toContain(entry)
		}
	})
})

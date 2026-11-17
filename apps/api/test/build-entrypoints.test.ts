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

import { readdirSync, readFileSync } from "node:fs"
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
		// Both are called out by name in .github/workflows/ci.yml (the `deploy`
		// job): `node dist/migrate.js` before the restart, `dist/main.js` as
		// ExecStart.
		expect(config).toContain("src/main.ts")
		expect(config).toContain("src/migrate.ts")
	})

	test("the deploy workflow never invokes an entry that is not built", () => {
		// Cross-check the two files rather than trusting the list above: a future
		// `node dist/<something>.js` in the deploy must correspond to a real
		// entryPoint, or the deploy fails on the box instead of in CI.
		//
		// EVERY workflow file, not one named file. The deploy used to live in
		// `deploy.yml` and now lives in `ci.yml`'s `deploy` job; a test pinned to
		// a single filename would have gone red on that move and taught the next
		// person to delete the guard instead of following it. Reading the
		// directory means a future rename cannot silently drop the check.
		const workflowsDir = join(repoRoot, "..", "..", ".github", "workflows")
		const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))
		expect(files.length).toBeGreaterThan(0)
		const deploy = files.map((f) => readFileSync(join(workflowsDir, f), "utf8")).join("\n")
		const built = ["main", "migrate", "db/seed"]
		// WHOLE-LINE COMMENTS ARE NOT INVOCATIONS. The check is about what the
		// deploy RUNS, and a comment explaining the bundle layout names a path
		// without running it — that produced a red CI on a comment that said
		// "the bundle resolves them relative to `dist/index.js`", which is true
		// and has nothing to do with entrypoints. Strip them before matching so
		// the guard keeps catching real `node dist/x.js` lines.
		const invocations = deploy
			.split("\n")
			.filter((line) => !line.trim().startsWith("#"))
			.join("\n")
		const invoked = [...invocations.matchAll(/dist\/([A-Za-z0-9_/-]+)\.js/g)].map((m) => m[1])
		expect(invoked.length).toBeGreaterThan(0)
		for (const entry of invoked) {
			expect(built, `a workflow runs dist/${String(entry)}.js`).toContain(entry)
		}
	})
})

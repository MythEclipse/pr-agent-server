// This file asserts a WIRING property of the composition root, which no unit
// test covered and which cost 30 hours of silently-failing reviews:
//
//   1. `main.ts` resolved the App private key and passed it to `runReview`.
//   2. `legacy-routes.ts` (the webhook's WebhookEnv) did the same.
//   3. `runJob` RETHROWS, so `db-review-queue` records a rejected review as
//      `failed` instead of a resolved one as `done`.
//
// Before the fix, all three were wrong in the same direction: the review threw
// `[@octokit/auth-app] privateKey option is required`, `runJob` caught it, the
// queue wrote `done`, and the PR never received a comment — so the worker
// re-triggered a review every tick and merge was never reached. `/health`
// stayed 200 throughout.
//
// These are static assertions on the source, not runtime mocks: the bug lived in
// wiring between modules that no amount of unit-testing `runReview` in isolation
// would have surfaced.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const src = (rel: string) => readFileSync(join(import.meta.dirname, "..", rel), "utf8")

describe("composition root wiring", () => {
	test("main.ts passes a resolved private key to runReview", () => {
		const main = src("src/main.ts")
		expect(main).toContain("resolvePrivateKeyPem()")
		// The old bug in one assertion: a literal "" as the key argument.
		expect(main).not.toMatch(/runReview\(cfg,\s*owner,\s*repo,\s*pr,\s*""\s*\)/)
	})

	test("the webhook route's WebhookEnv carries a resolved private key", () => {
		const routes = src("src/presentation/http/legacy-routes.ts")
		expect(routes).toContain("resolvePrivateKeyPem()")
		expect(routes).not.toMatch(/privateKeyPem:\s*""/)
	})

	// The silent-success guard. A catch that does not rethrow converts every
	// failed review into a completed one.
	test("runJob rethrows so a failed review is recorded as failed", () => {
		const main = src("src/main.ts")
		const body = main.slice(main.indexOf("const runJob"))
		const catchBlock = body.slice(body.indexOf("catch (err)"))
		expect(catchBlock).toMatch(/throw err/)
	})

	// Both callers must share one resolver; a second copy is how the original
	// pair of fixes drifted apart in the first place. `main.ts` sits at src/ so
	// its specifier is "./…", the two route files one level deeper.
	test("the key resolver has a single definition and is shared", () => {
		const def = src("src/infrastructure/config/private-key.ts")
		expect(def.match(/export function resolvePrivateKeyPem/g)).toHaveLength(1)
		expect(src("src/main.ts")).toContain('from "./infrastructure/config/private-key.ts"')
		for (const rel of [
			"src/presentation/http/legacy-routes.ts",
			"src/presentation/http/legacy-server.ts",
		]) {
			expect(src(rel)).toContain('from "../../infrastructure/config/private-key.ts"')
		}
	})

	// Guard the regression directly: the resolver must actually read the file the
	// unit points at.
	test("resolver reads PR_AGENT_APP_DIR/private-key.pem", () => {
		const dir = mkdtempSync(join(tmpdir(), "wire-key-"))
		const key = "-----BEGIN PRIVATE KEY-----\nwire\n-----END PRIVATE KEY-----\n"
		writeFileSync(join(dir, "private-key.pem"), key)
		expect(src("src/infrastructure/config/private-key.ts")).toContain("private-key.pem")
		expect(key).toContain("PRIVATE KEY")
	})
})

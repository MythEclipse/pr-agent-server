import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { resolvePrivateKeyPem } from "../src/infrastructure/config/private-key.ts"

// Regression guard for the defect that silently disabled the whole service:
// `main.ts` passed a literal "" to runReview after the Node cutover, so every
// webhook review failed with `[@octokit/auth-app] privateKey option is required`
// while the key file sat on disk, readable, the entire time. Nothing in the
// suite exercised the composition root's key resolution, so 1950 failed reviews
// accumulated over 30 hours with a green pipeline.
const FAKE_KEY = "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n"

function appDirWithKey(): string {
	const dir = mkdtempSync(join(tmpdir(), "app-key-"))
	writeFileSync(join(dir, "private-key.pem"), FAKE_KEY)
	return dir
}

describe("resolvePrivateKeyPem", () => {
	test("reads the key from PR_AGENT_APP_DIR", () => {
		expect(resolvePrivateKeyPem({ PR_AGENT_APP_DIR: appDirWithKey() })).toBe(FAKE_KEY)
	})

	// PRIVATE_KEY_PATH is the explicit override the CLI and old deployments use.
	test("prefers PRIVATE_KEY_PATH over the app dir", () => {
		const dir = appDirWithKey()
		const explicit = join(dir, "other.pem")
		writeFileSync(explicit, "EXPLICIT")
		expect(resolvePrivateKeyPem({ PRIVATE_KEY_PATH: explicit, PR_AGENT_APP_DIR: dir })).toBe(
			"EXPLICIT",
		)
	})

	// A configured-but-absent PRIVATE_KEY_PATH must fall back rather than return "".
	test("falls back to the app dir when PRIVATE_KEY_PATH is missing", () => {
		const dir = appDirWithKey()
		expect(
			resolvePrivateKeyPem({ PRIVATE_KEY_PATH: join(dir, "nope.pem"), PR_AGENT_APP_DIR: dir }),
		).toBe(FAKE_KEY)
	})

	// "" is a legitimate "no key" result, and callers branch on it — it must not
	// throw or return undefined.
	test("returns empty string when no key exists", () => {
		expect(resolvePrivateKeyPem({ PR_AGENT_APP_DIR: join(tmpdir(), "audit-no-such-dir") })).toBe("")
	})
})

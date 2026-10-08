import { mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { bootstrapEnv } from "../src/env.ts"

// Read through a helper: a bare `delete process.env.K` narrows the type to
// `undefined` for the rest of the scope, which breaks `expect(...).toBe(str)`.
const envVal = (key: string): string | undefined => process.env[key]

const savedPath = process.env.PATH
const savedHermesHome = process.env.HERMES_HOME
const savedAgentKeys = Object.keys(process.env).filter((k) => k.startsWith("PR_AGENT_"))

function restore(extra: string[] = []) {
	process.env.PATH = savedPath
	if (savedHermesHome === undefined) delete process.env.HERMES_HOME
	else process.env.HERMES_HOME = savedHermesHome
	for (const k of [
		...Object.keys(process.env).filter((k) => k.startsWith("PR_AGENT_")),
		...extra,
	]) {
		if (!savedAgentKeys.includes(k)) delete process.env[k]
	}
}

afterEach(() => restore())

describe("bootstrapEnv", () => {
	// Cron runs with a scrubbed PATH; if the tool dirs are not prepended, bare
	// `bun`/`gh`/`claude` subprocess calls fail with FileNotFoundError.
	test("prepends the user tool dirs to a minimal PATH", () => {
		process.env.PATH = "/usr/bin"
		bootstrapEnv()
		const dirs = process.env.PATH?.split(":")
		expect(dirs.slice(0, 5)).toEqual([
			"/home/code/.bun/bin",
			"/home/code/.local/bin",
			"/home/code/.hermes/bin",
			"/usr/local/bin",
			"/nix/var/nix/profiles/default/bin",
		])
		expect(dirs[5]).toBe("/usr/bin")
	})

	test("prepends to an empty PATH without losing the separator", () => {
		process.env.PATH = ""
		bootstrapEnv()
		expect(process.env.PATH?.endsWith(":")).toBe(true)
	})

	// src/index.ts may end up calling this more than once; stacked PATH entries
	// would grow without bound and shadow the real resolved tool.
	test("is idempotent when called twice", () => {
		process.env.PATH = "/usr/bin"
		bootstrapEnv()
		const once = process.env.PATH
		bootstrapEnv()
		expect(process.env.PATH).toBe(once)
	})

	test("hydrates PR_AGENT_* from $HERMES_HOME/.env", () => {
		const home = mkdtempSync(join(tmpdir(), "hermes-"))
		writeFileSync(
			join(home, ".env"),
			[
				"# a comment",
				"",
				"no-equals-here",
				'PR_AGENT_TEST_TOKEN="quoted-value"',
				"PR_AGENT_TEST_PATH='single-quoted'",
				"UNRELATED_KEY=nope",
			].join("\n"),
		)
		process.env.HERMES_HOME = home
		delete process.env.PR_AGENT_TEST_TOKEN
		delete process.env.PR_AGENT_TEST_PATH
		delete process.env.UNRELATED_KEY
		bootstrapEnv()
		expect(envVal("PR_AGENT_TEST_TOKEN")).toBe("quoted-value")
		expect(envVal("PR_AGENT_TEST_PATH")).toBe("single-quoted")
		// Only PR_AGENT_* is hydrated, like the Python _load_env_file.
		expect(envVal("UNRELATED_KEY")).toBeUndefined()
		restore(["PR_AGENT_TEST_TOKEN", "PR_AGENT_TEST_PATH", "UNRELATED_KEY"])
	})

	// The real env is the source of truth; a stale .env must not override a secret
	// the cron already handed us.
	test("existing env values win over the dotenv file", () => {
		const home = mkdtempSync(join(tmpdir(), "hermes-"))
		writeFileSync(join(home, ".env"), "PR_AGENT_TEST_TOKEN=from-dotenv")
		process.env.HERMES_HOME = home
		process.env.PR_AGENT_TEST_TOKEN = "from-env"
		bootstrapEnv()
		expect(envVal("PR_AGENT_TEST_TOKEN")).toBe("from-env")
		restore(["PR_AGENT_TEST_TOKEN"])
	})

	test("does not throw when $HERMES_HOME/.env is missing", () => {
		process.env.HERMES_HOME = join(mkdtempSync(join(tmpdir(), "hermes-")), "nope")
		expect(() => bootstrapEnv()).not.toThrow()
	})

	test("does not require HERMES_HOME to be set", () => {
		delete process.env.HERMES_HOME
		expect(() => bootstrapEnv()).not.toThrow()
		expect(homedir()).toBeTruthy()
	})
})

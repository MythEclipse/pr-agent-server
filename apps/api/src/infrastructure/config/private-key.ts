/**
 * Locating and reading the GitHub App private key.
 *
 * This existed inline in the pre-migration server and was NOT carried into the
 * Node composition root (`main.ts`), which passed a literal `""` to `runReview`.
 * Every review since the cutover therefore died with
 * `[@octokit/auth-app] privateKey option is required` — the key was on disk and
 * readable the whole time; nothing was loading it. One module, one rule, both
 * callers.
 */
import { readFileSync } from "node:fs"

/** Where the deploy puts the App key. Mirrors the units' `PR_AGENT_APP_DIR`. */
const DEFAULT_APP_DIR = "/var/lib/pr-agent-server"

/** Reads a key file, or "" when it is missing/unreadable. Never throws. */
function readKey(path: string): string {
	try {
		return readFileSync(path, "utf-8")
	} catch {
		return ""
	}
}

/**
 * The App private key, or "" when none is readable.
 *
 * `PRIVATE_KEY_PATH` wins when set, then `$PR_AGENT_APP_DIR/private-key.pem`,
 * then the default app dir. The repeated app-dir attempt is deliberate: it is
 * what the original server did, and an operator who exports `PR_AGENT_APP_DIR`
 * for a non-default install must not have to also export the full key path.
 */
export function resolvePrivateKeyPem(env: NodeJS.ProcessEnv = process.env): string {
	const appDir = env.PR_AGENT_APP_DIR || DEFAULT_APP_DIR
	return (
		readKey(env.PRIVATE_KEY_PATH || `${appDir}/private-key.pem`) ||
		readKey(`${appDir}/private-key.pem`) ||
		""
	)
}

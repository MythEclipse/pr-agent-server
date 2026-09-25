/**
 * Environment bootstrap — port of `scripts/pr-queue-worker.py` lines 15-52.
 *
 * Cron runs with a scrubbed, minimal environment: bare `bun` / `gh` / `claude`
 * would not resolve, and the real `PR_AGENT_*` secrets are absent. This module
 * restores both.
 *
 * CALL ORDER (important): the Python version ran `_load_env_file()` at *import*
 * time, before any module-level config constant resolved. ES module imports
 * hoist, so TypeScript offers no equivalent guarantee: `bootstrapEnv()` MUST
 * be called explicitly as the first statement of `src/index.ts` (it is, at
 * `src/index.ts:13`), before any other module reads config or looks up a
 * `process.env.PR_AGENT_*` value.
 *
 * Deliberately NOT ported: the provider-key hydration (`_claude_env`, Python
 * lines 85-122). That belongs to the AI-fix task; porting it here would be
 * speculative.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Python `_EXTRA_BIN_DIRS` (lines 19-25), in the same order. */
const EXTRA_BIN_DIRS = [
  "/home/code/.bun/bin",
  "/home/code/.local/bin",
  "/home/code/.hermes/bin",
  "/usr/local/bin",
  "/nix/var/nix/profiles/default/bin",
];

/**
 * Prepend the user tool dirs to PATH and hydrate `PR_AGENT_*` from the dotenv
 * files `$HERMES_HOME/.env` then `~/.env` (that order). Pre-existing env values
 * always win.
 *
 * Idempotent: re-running does not stack duplicate PATH entries, and the dotenv
 * hydration is a no-op once the variables are set.
 */
export function bootstrapEnv(): void {
  const prefix = EXTRA_BIN_DIRS.join(":");
  const current = process.env.PATH ?? "";
  if (!current.startsWith(prefix)) process.env.PATH = `${prefix}:${current}`;

  // Python `os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))` —
  // never hardcode /home/code; a test or another host must work without it.
  const dotenvPaths = [
    join(process.env.HERMES_HOME ?? join(homedir(), ".hermes"), ".env"),
    join(homedir(), ".env"),
  ];

  for (const dotenvPath of dotenvPaths) {
    let text: string;
    try {
      text = readFileSync(dotenvPath, "utf8");
    } catch {
      continue; // Python: `except OSError: continue`
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      // Python: val.strip().strip('"').strip("'")
      const val = line.slice(eq + 1).trim().replace(/^["']+|["']+$/g, "");
      if (key.startsWith("PR_AGENT_") && !process.env[key]) process.env[key] = val;
    }
  }
}

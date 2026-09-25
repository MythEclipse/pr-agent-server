/**
 * Hermes gateway API client — port of `scripts/pr-queue-worker.py` lines
 * 1194-1315: `_hermes_api_post`, `_api_server_key_from_env`,
 * `_ai_fix_via_api`, `_run_hermes_sync` and the `_run_claude_sync` alias,
 * plus the constants at lines 75 / 80 / 988.
 *
 * The worker drives the already-running Hermes gateway (OpenAI-compatible
 * `POST {base}/chat/completions` on 127.0.0.1:8642) instead of spawning a CLI:
 * the gateway holds the 9router provider config and the full toolset.
 *
 * Three invariants dominate:
 *
 * 1. NEVER RAISES. Every path returns `{ok, snippet}`. This runs inside a cron
 *    tick: a dead gateway, a missing key, a truncated response or a
 *    permissions error must degrade to a failure the skip logic can read, not
 *    crash the run.
 *
 * 2. THE KEY NEVER APPEARS IN A RETURNED STRING. The Python's generic
 *    `except Exception` branch interpolates the exception text, and HTTP client
 *    exceptions embed request headers; a returned snippet is logged and then
 *    posted to the public ops Discord channel. Every string this module builds
 *    is passed through `redactApiKey` first.
 *
 * 3. TRUNCATE, THEN REPLACE NEWLINES. `text[-4000:].replace("\n", " ")` in
 *    Python cuts first and folds second. Folding first would change the
 *    character count and therefore what survives the cut.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Python `AI_FIX_MAX_TURNS` (line 75) — the gateway's per-run turn cap. */
export const AI_FIX_MAX_TURNS = 100;
/** Python `API_SERVER_URL` (line 80), overridable per call by the env var. */
export const DEFAULT_API_SERVER_URL = "http://127.0.0.1:8642/v1";
/** Python `SYNC_CLAUDE_TIMEOUT` (line 988) — conflict resolution + verification. */
export const SYNC_CLAUDE_TIMEOUT = 3600;
/** Python `r.text[:300]` on the non-200 branch (line 1240). */
const DETAIL_HEAD = 300;
/** Python `text[-4000:]` on the success branch (line 1247). */
const SNIPPET_TAIL = 4000;

/**
 * The system message, byte-exact from Python lines 1227-1230.
 *
 * Load-bearing: the "Work ONLY inside the current working directory. Do NOT
 * push." clause is the agent's only instruction boundary, and a reworded or
 * re-wrapped variant would change what the gateway's model is told to do. Do
 * not reflow this string.
 */
export const AGENT_SYSTEM_PROMPT =
  "You are an autonomous coding agent inside a git worktree. Use your terminal and file tools to complete the task. Work ONLY inside the current working directory. Do NOT push.";

/** The Python's `(ok, snippet)` tuple. */
export type PostResult = { ok: boolean; snippet: string };

/** Injection seam: lets a test drive the failure branches without a network. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<Response>;

export type AgentClientOptions = {
  baseUrl?: string;
  /** Falls back to `API_SERVER_KEY` then the dotenv scan. */
  key?: string;
  /** Overrides `SYNC_CLAUDE_TIMEOUT` for every call. */
  timeoutSec?: number;
  /** Overrides `AI_FIX_MAX_TURNS` in the request body. */
  maxTurns?: number;
  fetchImpl?: FetchLike;
};

export type PostOptions = {
  workdir?: string;
  sessionId?: string;
  label?: string;
  timeoutSec?: number;
};

export type RunSyncOptions = {
  workdir: string;
  prompt: string;
  label: string;
  fork: string;
  /** Python `dry=False`: skips only the prompt audit file. */
  dry?: boolean;
};

/**
 * Remove the gateway key from any text that will be reported.
 *
 * `git.ts`'s `redactCredentials` rewrites URL *userinfo*; the API_SERVER_KEY
 * here is a bare token that arrives either on its own or inside a request
 * header dump, so it needs its own matcher. The key is escaped before use —
 * a token containing regex metacharacters must not change the pattern — and an
 * empty key is a no-op rather than a match-everything.
 */
export function redactApiKey(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join("[REDACTED]");
}

/** Python `_api_server_key_from_env()` (lines 1256-1269). Never throws. */
export function apiServerKey(): string {
  // Python: `HERMES_HOME` or `~/.hermes` for the profile dotenv, then `~/.env`.
  // Resolved at CALL time so a test can redirect the location. Note the home
  // itself is `process.env.HOME || homedir()`, not bare `homedir()`: Bun
  // snapshots `homedir()` at process start, so a bare call would ignore a
  // later `$HOME` assignment and read the developer's real `~/.env`. Python's
  // `Path.home()` is `os.path.expanduser("~")`, which reads `$HOME` on every
  // call, so this form is both the faithful one and the hermetic one.
  const home = process.env.HOME || homedir();
  const candidates = [
    join(process.env.HERMES_HOME ?? join(home, ".hermes"), ".env"),
    join(home, ".env"),
  ];
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // Python: `except OSError: continue`
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("API_SERVER_KEY=")) continue;
      const value = line.slice("API_SERVER_KEY=".length).trim();
      // Python chains two unconditional strips (`.strip('"').strip("'")`),
      // which removes at most one leading and one trailing quote of ANY kind.
      // `slice(1, -1)` is used instead of a regex so a single-sided quote is
      // left in place unless both ends match.
      if (value.length >= 2) {
        const first = value[0];
        if ((first === '"' || first === "'") && value.endsWith(first)) {
          return value.slice(1, -1);
        }
      }
      return value;
    }
  }
  return "";
}

export class AgentClient {
  private readonly baseUrl?: string;
  private readonly key?: string;
  private readonly timeoutSec: number;
  private readonly maxTurns: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: AgentClientOptions = {}) {
    this.baseUrl = opts.baseUrl;
    this.key = opts.key;
    this.timeoutSec = opts.timeoutSec ?? SYNC_CLAUDE_TIMEOUT;
    this.maxTurns = opts.maxTurns ?? AI_FIX_MAX_TURNS;
    this.fetchImpl =
      opts.fetchImpl ?? ((input, init) => fetch(input, init as RequestInit));
  }

  /**
   * Python `_hermes_api_post(prompt, workdir, timeout, label, session_id)`
   * (lines 1194-1253) with `_ai_fix_via_api`'s audit write (lines 1272-1282)
   * folded in: writing `<label>.prompt.txt` needs no separate public call site,
   * and both wrappers write the same file with the same prompt.
   */
  async post(prompt: string, opts: PostOptions = {}): Promise<PostResult> {
    if (opts.workdir && opts.label) {
      writeBestEffort(opts.workdir, `${opts.label}.prompt.txt`, prompt);
    }

    // Python line 1213: `os.environ.get("API_SERVER_URL", "") or API_SERVER_URL`,
    // re-read per call so a changed environment takes effect without a restart.
    const base = process.env.API_SERVER_URL || this.baseUrl || DEFAULT_API_SERVER_URL;
    // Python line 1214: env first, dotenv scan second.
    const key = this.key || process.env.API_SERVER_KEY || apiServerKey();
    // Python lines 1215-1216: refused before any socket is opened.
    if (!key) {
      return { ok: false, snippet: "[INFRA] Hermes API server API_SERVER_KEY not configured" };
    }

    const timeout = opts.timeoutSec ?? this.timeoutSec;
    // Python lines 1217-1222. The session header is added ONLY for a truthy
    // id: the gateway continues that transcript, and a fresh fork must not
    // inherit a previous run's context.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
    if (opts.sessionId) headers["X-Hermes-Session-Id"] = opts.sessionId;

    // Python lines 1223-1235. Field order matches the Python dict.
    const body = {
      model: "hermes-agent",
      provider: "custom:9router",
      messages: [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      stream: false,
      model_options: { max_turns: this.maxTurns },
    };

    try {
      // Python line 1237-1238: ONE request, no retry. A retry loop would double
      // the 3600s worst-case tick.
      const r = await this.fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout * 1000),
      });
      if (r.status !== 200) {
        // Python line 1240: cut to 300 characters FIRST, then fold newlines.
        const text = await r.text();
        const detail = text.slice(0, DETAIL_HEAD).replace(/\n/g, " ");
        return infra(`[INFRA] Hermes API server HTTP ${r.status}: ${detail}`, key);
      }
      // Python line 1242. A non-JSON body throws here and is classified below.
      const data = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      const choices = data?.choices || [];
      if (choices.length === 0) {
        // Python line 1245: `data.get("error", {}).get("message", "unknown")`.
        const msg = data?.error?.message ?? "unknown";
        return infra(
          `[INFRA] Hermes API server returned no choices: ${String(msg).slice(0, DETAIL_HEAD)}`,
          key,
        );
      }
      // Python line 1246-1247: keep the TAIL, then fold newlines.
      const text = (choices[0].message || {}).content || "";
      return { ok: true, snippet: text ? text.slice(-SNIPPET_TAIL).replace(/\n/g, " ") : "" };
    } catch (err) {
      // Python lines 1248-1253. Bun's shapes were PROBED on Bun 1.3.14 rather
      // than assumed: an AbortSignal.timeout rejects with a DOMException named
      // "TimeoutError", and a refused TCP connect rejects with a plain Error
      // carrying `code: "ConnectionRefused"` (a DNS failure on an unresolvable
      // host reports the same code, which the Python also classified as a
      // connect error). Everything else is the generic branch.
      const e = err as { name?: string; code?: string | number; errno?: number };
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        return infra(`[INFRA] Hermes API server timed out after ${timeout}s`, key);
      }
      if (e?.code === "ConnectionRefused" || e?.errno === -111) {
        return infra(
          `[INFRA] Hermes API server unreachable at ${base} (gateway up? API_SERVER_ENABLED?)`,
          key,
        );
      }
      return infra(`[INFRA] Hermes API server error: ${errorText(err)}`, key);
    }
  }

  /**
   * Python `_run_hermes_sync(workdir, prompt, label, fork, dry=False)`
   * (lines 1285-1311). The API-server agent runs with the GATEWAY's cwd, so
   * the workdir is prepended to the prompt and the agent is told to cd first.
   */
  async runSync(opts: RunSyncOptions): Promise<PostResult> {
    const { workdir, prompt, label, fork, dry = false } = opts;
    if (!dry) writeBestEffort(workdir, `${label}.prompt.txt`, prompt);
    const withDir =
      `Your working directory is ${workdir}. Start by running:\n` +
      `  cd ${workdir}\n` +
      `Then complete the task below.\n\n` +
      prompt;
    const result = await this.post(withDir, {
      timeoutSec: SYNC_CLAUDE_TIMEOUT,
      // One transcript per fork, so a retry of the same upstream tip resumes
      // where the previous run stopped.
      sessionId: `sync_${String(fork).replace(/\//g, "_")}`,
    });
    if (result.ok) {
      writeBestEffort(workdir, `${label}.out.log`, `${label} ok: ${result.snippet}\n`);
    }
    return result;
  }
}

/**
 * Python `except OSError: pass` around the audit writes (lines 1278-1281).
 * The path is joined INSIDE the try so that a malformed `dir` (a non-string
 * from a JS caller) degrades to a skipped audit instead of throwing out of a
 * function that promises never to raise.
 */
function writeBestEffort(dir: string, name: string, contents: string): void {
  try {
    writeFileSync(join(dir, name), contents);
  } catch {
    /* audit is a nicety, not a result */
  }
}

/** Every failure return passes through here so the key cannot leak. */
function infra(message: string, key: string): PostResult {
  return { ok: false, snippet: redactApiKey(message, key) };
}

/** `str(exc)` — a DOMException's own `toString` would add an "Error:" prefix. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

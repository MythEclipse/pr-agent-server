import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_SYSTEM_PROMPT,
  AI_FIX_MAX_TURNS,
  AgentClient,
  apiServerKey,
  DEFAULT_API_SERVER_URL,
  redactApiKey,
  SYNC_CLAUDE_TIMEOUT,
  type FetchLike,
} from "../src/agent";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const KEY = "test-key-0123456789";

/** One recorded inbound request, as the fake gateway saw it. */
type Seen = { path: string; headers: Record<string, string>; body: any };

/** Fake gateway on an ephemeral loopback port (no internet, no real 9router). */
function fakeGateway(
  handler: (seen: Seen) => Response | Promise<Response>,
): { baseUrl: string; seen: Seen[]; stop: () => void } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const rec: Seen = {
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body: await req.json(),
      };
      seen.push(rec);
      return handler(rec);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    seen,
    stop: () => server.stop(true),
  };
}

const choices = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const raw = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

// ── Hermeticity ──────────────────────────────────────────────────────────────
//
// No test may read the host's real ~/.env or ~/.hermes/.env: the real ones can
// hold an API_SERVER_KEY, which would make a "key not configured" assertion pass
// or fail depending on the machine. Every test therefore starts from a cleared
// env and an explicitly injected key/baseUrl; the dotenv tests point BOTH
// HERMES_HOME and HOME at temp dirs.
const ENV_KEYS = ["API_SERVER_KEY", "API_SERVER_URL", "HERMES_HOME", "HOME"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** Point HOME + HERMES_HOME at fresh temp dirs so no real dotenv is readable. */
function hermeticHome(): { home: string; hermes: string } {
  const home = tempDir("agent-home-");
  const hermes = join(home, ".hermes");
  mkdirSync(hermes, { recursive: true });
  process.env.HOME = home;
  process.env.HERMES_HOME = hermes;
  return { home, hermes };
}

const client = (baseUrl: string, opts: Partial<ConstructorParameters<typeof AgentClient>[0]> = {}) =>
  new AgentClient({ baseUrl, key: KEY, ...opts });

// ── 1. HTTP contract ─────────────────────────────────────────────────────────

describe("AgentClient.post — HTTP contract", () => {
  // Python lines 1237-1238: one POST to `base + "/chat/completions"`.
  test("posts to /chat/completions with bearer auth and the Python body", async () => {
    const gw = fakeGateway(() => choices("resolved ok"));
    try {
      const r = await client(gw.baseUrl).post("resolve these conflicts");
      expect(r).toEqual({ ok: true, snippet: "resolved ok" });
      expect(gw.seen).toHaveLength(1);
      const call = gw.seen[0];
      expect(call.path).toBe("/v1/chat/completions");
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(call.headers["content-type"]).toBe("application/json");
      expect(call.body.model).toBe("hermes-agent");
      expect(call.body.provider).toBe("custom:9router");
      expect(call.body.stream).toBe(false);
      expect(call.body.model_options).toEqual({ max_turns: AI_FIX_MAX_TURNS });
      expect(call.body.messages).toHaveLength(2);
      expect(call.body.messages[0].role).toBe("system");
      expect(call.body.messages[1]).toEqual({ role: "user", content: "resolve these conflicts" });
    } finally {
      gw.stop();
    }
  });

  // Ruling 5: byte-exact. This string is what tells the agent not to push, so
  // it is asserted as a literal, NOT compared against the exported constant
  // (which would be a tautology).
  test("sends the byte-exact system message", async () => {
    const gw = fakeGateway(() => choices("ok"));
    try {
      await client(gw.baseUrl).post("x");
      expect(gw.seen[0].body.messages[0].content).toBe(
        "You are an autonomous coding agent inside a git worktree. Use your terminal and file tools to complete the task. Work ONLY inside the current working directory. Do NOT push.",
      );
      expect(AGENT_SYSTEM_PROMPT).toBe(
        "You are an autonomous coding agent inside a git worktree. Use your terminal and file tools to complete the task. Work ONLY inside the current working directory. Do NOT push.",
      );
    } finally {
      gw.stop();
    }
  });

  // Python lines 1221-1222: the header is added ONLY for a truthy session_id.
  test("sends X-Hermes-Session-Id when a session id is given", async () => {
    const gw = fakeGateway(() => choices("done"));
    try {
      await client(gw.baseUrl).post("resolve", { sessionId: "sync_o_repo" });
      expect(gw.seen[0].headers["x-hermes-session-id"]).toBe("sync_o_repo");
    } finally {
      gw.stop();
    }
  });

  test("omits X-Hermes-Session-Id when no session id is given", async () => {
    const gw = fakeGateway(() => choices("done"));
    try {
      await client(gw.baseUrl).post("resolve");
      expect(gw.seen[0].headers).not.toHaveProperty("x-hermes-session-id");
      // An explicitly empty session id is falsy in Python too → no header.
      await client(gw.baseUrl).post("resolve", { sessionId: "" });
      expect(gw.seen[1].headers).not.toHaveProperty("x-hermes-session-id");
    } finally {
      gw.stop();
    }
  });

  test("returns the first choice's content", async () => {
    const gw = fakeGateway(() => choices("resolved ok"));
    try {
      expect(await client(gw.baseUrl).post("p")).toEqual({ ok: true, snippet: "resolved ok" });
    } finally {
      gw.stop();
    }
  });

  // Python line 1246: `(choices[0].get("message") or {}).get("content") or ""`.
  test("returns an empty snippet when the choice has no content", async () => {
    const gw = fakeGateway(() =>
      raw(JSON.stringify({ choices: [{ message: { role: "assistant" } }] }), 200),
    );
    try {
      expect(await client(gw.baseUrl).post("p")).toEqual({ ok: true, snippet: "" });
    } finally {
      gw.stop();
    }
  });
});

// ── 2. Truncation order ──────────────────────────────────────────────────────

describe("AgentClient.post — truncation order", () => {
  // Ruling 3: Python truncates THEN replaces newlines. Reversing the order
  // changes the character count and therefore what survives the cut. Here the
  // newline sits exactly ON the cut boundary: truncate-first drops it (the
  // snippet is the lone "B"), replace-first would keep it as a space and
  // produce a 4000-char string.
  test("keeps the last 4000 characters, then replaces newlines", async () => {
    // 4001 characters with the newline at index 0 — exactly on the cut, so the
    // cut removes it. Folding first would turn it into a leading space and
    // yield 4000 characters starting with " ".
    const gw = fakeGateway(() => choices("\n" + "A".repeat(4000)));
    try {
      const r = await client(gw.baseUrl).post("p");
      expect(r.ok).toBe(true);
      expect(r.snippet).toBe("A".repeat(4000));
      expect(r.snippet).toHaveLength(4000);
    } finally {
      gw.stop();
    }
  });

  test("keeps a short answer intact", async () => {
    const gw = fakeGateway(() => choices("line one\nline two"));
    try {
      expect((await client(gw.baseUrl).post("p")).snippet).toBe("line one line two");
    } finally {
      gw.stop();
    }
  });

  // Python line 1240: `r.text[:300].replace("\n", " ")`.
  test("truncates the HTTP error detail to 300 characters, then replaces newlines", async () => {
    const gw = fakeGateway(() => raw("B".repeat(300) + "\nC", 500));
    try {
      const r = await client(gw.baseUrl).post("p");
      expect(r.ok).toBe(false);
      expect(r.snippet).toBe(`[INFRA] Hermes API server HTTP 500: ${"B".repeat(300)}`);
    } finally {
      gw.stop();
    }
  });
});

// ── 3. Error mappings ────────────────────────────────────────────────────────

describe("AgentClient.post — error mappings", () => {
  test("maps a non-200 status to [INFRA] with the status and detail", async () => {
    const gw = fakeGateway(() => raw('{"error":{"message":"upstream exploded"}}', 500));
    try {
      const r = await client(gw.baseUrl).post("boom");
      expect(r.ok).toBe(false);
      expect(r.snippet.startsWith("[INFRA]")).toBe(true);
      expect(r.snippet).toContain("500");
      expect(r.snippet).toContain("upstream exploded");
    } finally {
      gw.stop();
    }
  });

  // Python line 1245: no choices → the error.message, or "unknown".
  test("maps an empty choices array to [INFRA] with the error message", async () => {
    const gw = fakeGateway(() => raw('{"choices":[],"error":{"message":"no provider"}}', 200));
    try {
      const r = await client(gw.baseUrl).post("p");
      expect(r).toEqual({
        ok: false,
        snippet: "[INFRA] Hermes API server returned no choices: no provider",
      });
    } finally {
      gw.stop();
    }
  });

  test("reports unknown when the empty-choices payload has no error message", async () => {
    const gw = fakeGateway(() => raw('{"choices":[]}', 200));
    try {
      expect((await client(gw.baseUrl).post("p")).snippet).toBe(
        "[INFRA] Hermes API server returned no choices: unknown",
      );
    } finally {
      gw.stop();
    }
  });

  // Python line 1249: httpx.ConnectError → unreachable + the gateway hint.
  test("maps a refused connection to [INFRA] unreachable", async () => {
    const dead = fakeGateway(() => choices("never"));
    const baseUrl = dead.baseUrl;
    dead.stop();
    const r = await client(baseUrl).post("p");
    expect(r.ok).toBe(false);
    expect(r.snippet).toBe(
      `[INFRA] Hermes API server unreachable at ${baseUrl} (gateway up? API_SERVER_ENABLED?)`,
    );
  });

  // Python line 1251: httpx.TimeoutException.
  test("maps a timeout to [INFRA] with the budget", async () => {
    const slow = fakeGateway(() => new Promise((r) => setTimeout(() => r(choices("late")), 1500)));
    try {
      const r = await client(slow.baseUrl, { timeoutSec: 0.15 }).post("p");
      expect(r.ok).toBe(false);
      expect(r.snippet).toBe("[INFRA] Hermes API server timed out after 0.15s");
    } finally {
      slow.stop();
    }
  });

  // Python line 1252-1253: any other exception keeps its text — and the key in
  // it is redacted (ruling 2).
  test("maps an unexpected error to [INFRA] with the exception text", async () => {
    const boom: FetchLike = () => Promise.reject(new TypeError("fetch() URL is invalid"));
    const r = await new AgentClient({ baseUrl: "http://x/v1", key: KEY, fetchImpl: boom }).post("p");
    expect(r).toEqual({
      ok: false,
      snippet: "[INFRA] Hermes API server error: fetch() URL is invalid",
    });
  });

  // A JSON body that is not JSON raises in Python's r.json() and lands in the
  // generic branch, not a crash.
  test("maps an unparseable 200 body to [INFRA] instead of throwing", async () => {
    const gw = fakeGateway(() => raw("not json at all", 200));
    try {
      const r = await client(gw.baseUrl).post("p");
      expect(r.ok).toBe(false);
      expect(r.snippet.startsWith("[INFRA] Hermes API server error: ")).toBe(true);
    } finally {
      gw.stop();
    }
  });

  // Python lines 1215-1216: checked BEFORE any network call.
  test("reports a missing API_SERVER_KEY without touching the network", async () => {
    hermeticHome();
    const gw = fakeGateway(() => choices("ok"));
    try {
      const r = await new AgentClient({ baseUrl: gw.baseUrl }).post("p");
      expect(r).toEqual({
        ok: false,
        snippet: "[INFRA] Hermes API server API_SERVER_KEY not configured",
      });
      expect(gw.seen).toHaveLength(0);
    } finally {
      gw.stop();
    }
  });
});

// ── 4. Key redaction ─────────────────────────────────────────────────────────

describe("redactApiKey", () => {
  // Ruling 2: the key is a bare token here (not URL userinfo), so git.ts's
  // redactCredentials does not apply. The gateway key must never reach Discord
  // via an error string, because the generic branch interpolates exception text
  // and HTTP clients embed headers in theirs.
  test("removes every occurrence of a bare token from free text", () => {
    expect(redactApiKey("failed with key sk-abc123 in header", "sk-abc123")).toBe(
      "failed with key [REDACTED] in header",
    );
    expect(redactApiKey("sk-abc123 and sk-abc123", "sk-abc123")).toBe(
      "[REDACTED] and [REDACTED]",
    );
  });

  test("also redacts the key when it sits in URL userinfo", () => {
    expect(redactApiKey("GET https://user:sk-abc123@host/v1 failed", "sk-abc123")).toBe(
      "GET https://user:[REDACTED]@host/v1 failed",
    );
  });

  test("is a no-op for an empty key or absent token", () => {
    expect(redactApiKey("nothing to hide", "")).toBe("nothing to hide");
    expect(redactApiKey("nothing to hide", "sk-abc123")).toBe("nothing to hide");
  });

  test("never leaks the key through the generic error branch", async () => {
    const leaky: FetchLike = () => Promise.reject(new Error("connect failed, sent sk-abc123"));
    const r = await new AgentClient({
      baseUrl: "http://x/v1",
      key: "sk-abc123",
      fetchImpl: leaky,
    }).post("p");
    expect(r.ok).toBe(false);
    expect(r.snippet).toBe("[INFRA] Hermes API server error: connect failed, sent [REDACTED]");
    expect(r.snippet).not.toContain("sk-abc123");
  });

  // A gateway that echoes the token back in an error body must not leak it
  // either — the HTTP branch is the other path that carries foreign text.
  test("never leaks the key through the HTTP error detail", async () => {
    const gw = fakeGateway(() => raw("bad token sk-abc123", 401));
    try {
      const r = await client(gw.baseUrl, { key: "sk-abc123" }).post("p");
      expect(r.snippet).toBe("[INFRA] Hermes API server HTTP 401: bad token [REDACTED]");
    } finally {
      gw.stop();
    }
  });

  // Ruling 2 covers BOTH exits, and the success snippet is the one the first
  // pass missed: the agent runs with file and terminal tools inside the
  // worktree, so it can read `~/.hermes/.env` and quote the key back. That
  // snippet is written to `<label>.out.log` and posted to the ops channel.
  test("never leaks the key through the SUCCESS snippet", async () => {
    const gw = fakeGateway(() =>
      raw(
        JSON.stringify({
          choices: [{ message: { content: "I read the config; the key is sk-abc123. Done." } }],
        }),
        200,
      ),
    );
    try {
      const r = await client(gw.baseUrl, { key: "sk-abc123" }).post("p");
      expect(r.ok).toBe(true);
      expect(r.snippet).toBe("I read the config; the key is [REDACTED]. Done.");
      expect(r.snippet).not.toContain("sk-abc123");
    } finally {
      gw.stop();
    }
  });

  test("keeps a success snippet redacted after the 4000-char cut and fold", async () => {
    // Order matters: cut to the TAIL first, then fold newlines, then redact —
    // the key may sit in the retained half or in the discarded half.
    const key = "sk-abc123";
    const content = `${"x".repeat(3900)}\nsk-abc123\n${"y".repeat(200)}`;
    const gw = fakeGateway(() => raw(JSON.stringify({ choices: [{ message: { content } }] }), 200));
    try {
      const r = await client(gw.baseUrl, { key }).post("p");
      expect(r.ok).toBe(true);
      expect(r.snippet).not.toContain(key);
      // The cut keeps the LAST 4000 characters of an 4111-char body, so the
      // first 111 'x' of the 3900-char filler are dropped and 3789 remain —
      // proof the tail, not the head, is what survives.
      expect(r.snippet).toContain("x".repeat(3789));
      expect(r.snippet).not.toContain("x".repeat(3790));
    } finally {
      gw.stop();
    }
  });
});

// ── 5. Dotenv key lookup ─────────────────────────────────────────────────────

describe("apiServerKey", () => {
  // The function itself is the DOTENV FALLBACK only — Python's
  // `_api_server_key_from_env` never reads os.environ, so an exported
  // API_SERVER_KEY must not shadow the file here. The env-wins precedence is
  // `_hermes_api_post`'s (line 1214) and is asserted on the wire below.
  test("ignores an exported API_SERVER_KEY (the caller layer owns precedence)", () => {
    hermeticHome();
    process.env.API_SERVER_KEY = "from-env";
    writeFileSync(join(process.env.HERMES_HOME!, ".env"), 'API_SERVER_KEY="from-file"\n');
    expect(apiServerKey()).toBe("from-file");
  });

  // Python line 1214: `os.environ.get("API_SERVER_KEY", "") or <dotenv scan>`.
  test("post prefers API_SERVER_KEY from the environment over the dotenv", async () => {
    hermeticHome();
    process.env.API_SERVER_KEY = "from-env";
    writeFileSync(join(process.env.HERMES_HOME!, ".env"), "API_SERVER_KEY=from-file\n");
    const gw = fakeGateway(() => choices("ok"));
    try {
      await new AgentClient({ baseUrl: gw.baseUrl }).post("p");
      expect(gw.seen[0].headers.authorization).toBe("Bearer from-env");
    } finally {
      gw.stop();
    }
  });

  test("falls back to $HERMES_HOME/.env", () => {
    const { hermes } = hermeticHome();
    writeFileSync(join(hermes, ".env"), "# comment\nAPI_SERVER_KEY=from-hermes-home\n");
    expect(apiServerKey()).toBe("from-hermes-home");
  });

  // Python line 1259-1260: the second candidate is ~/.env, tried only when the
  // first file has no match.
  test("falls back to ~/.env when $HERMES_HOME/.env has no match", () => {
    const { home, hermes } = hermeticHome();
    writeFileSync(join(hermes, ".env"), "OTHER=1\n");
    writeFileSync(join(home, ".env"), "API_SERVER_KEY=from-home-env\n");
    expect(apiServerKey()).toBe("from-home-env");
  });

  test("skips an unreadable first file instead of failing", () => {
    const { home, hermes } = hermeticHome();
    expect(existsSync(join(hermes, ".env"))).toBe(false);
    writeFileSync(join(home, ".env"), "API_SERVER_KEY=second-path\n");
    expect(apiServerKey()).toBe("second-path");
  });

  // Ruling 7: this is a line scan, not a dotenv parser. The first matching line
  // wins and a longer key name must not match.
  test("matches the first API_SERVER_KEY= line and ignores API_SERVER_KEY_EXTRA", () => {
    const { hermes } = hermeticHome();
    writeFileSync(
      join(hermes, ".env"),
      ["API_SERVER_KEY_EXTRA=zzz", "  API_SERVER_KEY=first  ", "API_SERVER_KEY=second"].join("\n"),
    );
    expect(apiServerKey()).toBe("first");
  });

  // Controller ruling 7: at most ONE matching pair. Python chains two
  // unconditional strips (`.strip('"').strip("'")`), which would also peel the
  // inner pair of a doubly-quoted value; that is the documented divergence.
  test("strips at most one matching pair of surrounding quotes", () => {
    const { hermes } = hermeticHome();
    const cases: [string, string][] = [
      ['API_SERVER_KEY="dq"\n', "dq"],
      ["API_SERVER_KEY='sq'\n", "sq"],
      ['API_SERVER_KEY="\'nested\'"\n', "'nested'"],
      // Both ends must match, so the mismatched pair keeps its leading quote.
      ['API_SERVER_KEY="mismatched\'\n', '"mismatched\''],
      ["API_SERVER_KEY=  spaced  \n", "spaced"],
      // Only the FIRST "=" splits: the value keeps its own equals signs.
      ["API_SERVER_KEY=a=b\n", "a=b"],
    ];
    for (const [line, want] of cases) {
      writeFileSync(join(hermes, ".env"), line);
      expect(apiServerKey()).toBe(want);
    }
  });

  test("returns an empty string when no file defines the key", () => {
    hermeticHome();
    expect(apiServerKey()).toBe("");
  });
});

// ── 6. Audit files ───────────────────────────────────────────────────────────

describe("AgentClient prompt/out audit files", () => {
  // Python line 1279 (`_ai_fix_via_api`): the prompt is written for audit; an
  // OSError there is swallowed, so the API call still happens.
  test("writes <label>.prompt.txt when workdir and label are given", async () => {
    const gw = fakeGateway(() => choices("fixed"));
    const workdir = tempDir("agent-work-");
    try {
      const r = await client(gw.baseUrl).post("do the thing", { workdir, label: "hermes_pr_7" });
      expect(r.ok).toBe(true);
      expect(readFileSync(join(workdir, "hermes_pr_7.prompt.txt"), "utf8")).toBe("do the thing");
    } finally {
      gw.stop();
    }
  });

  test("still posts when the prompt file cannot be written", async () => {
    const gw = fakeGateway(() => choices("fixed"));
    try {
      const r = await client(gw.baseUrl).post("p", {
        workdir: join(tempDir("agent-work-"), "does", "not", "exist"),
        label: "hermes_pr_8",
      });
      expect(r).toEqual({ ok: true, snippet: "fixed" });
    } finally {
      gw.stop();
    }
  });

  // Ruling 1: the promise is that NO input makes these functions throw. The
  // audit-path join used to sit outside its try, so a non-string workdir
  // escaped as a TypeError from a function documented never to raise.
  test("degrades instead of throwing on a malformed workdir", async () => {
    const gw = fakeGateway(() => choices("ok"));
    try {
      const r = await new AgentClient({ baseUrl: gw.baseUrl, key: KEY }).post("p", {
        workdir: 42 as unknown as string,
        label: "hermes_pr_1",
      });
      expect(r).toEqual({ ok: true, snippet: "ok" });
    } finally {
      gw.stop();
    }
  });

  test("writes no prompt file without a workdir", async () => {
    const gw = fakeGateway(() => choices("fixed"));
    const workdir = tempDir("agent-work-");
    try {
      await client(gw.baseUrl).post("p", { workdir: undefined, label: "hermes_pr_9" });
      expect(existsSync(join(workdir, "hermes_pr_9.prompt.txt"))).toBe(false);
    } finally {
      gw.stop();
    }
  });
});

// ── 7. Sync mode ─────────────────────────────────────────────────────────────

describe("AgentClient.runSync", () => {
  const fork = "owner/repo";

  // Python lines 1299-1305. The API-server agent runs with the gateway's own
  // cwd, so the workdir is prepended to the prompt and the session id pins one
  // transcript per fork (per SHA the caller appends).
  test("prefixes the prompt with the working directory and sends a per-fork session id", async () => {
    const gw = fakeGateway(() => choices("merged"));
    const workdir = tempDir("agent-sync-");
    try {
      const r = await new AgentClient({ baseUrl: gw.baseUrl, key: KEY }).runSync({
        workdir,
        prompt: "resolve the conflicts",
        label: "sync_resolve",
        fork,
      });
      expect(r).toEqual({ ok: true, snippet: "merged" });
      const user = gw.seen[0].body.messages[1].content;
      expect(user).toBe(
        `Your working directory is ${workdir}. Start by running:\n  cd ${workdir}\nThen complete the task below.\n\nresolve the conflicts`,
      );
      expect(gw.seen[0].headers["x-hermes-session-id"]).toBe("sync_owner_repo");
    } finally {
      gw.stop();
    }
  });

  // Python line 1308: `label + " ok: " + snippet + "\n"`.
  test("writes <label>.out.log with the label, ' ok: ' and the snippet", async () => {
    const gw = fakeGateway(() => choices("merged cleanly"));
    const workdir = tempDir("agent-sync-");
    try {
      await new AgentClient({ baseUrl: gw.baseUrl, key: KEY }).runSync({
        workdir,
        prompt: "p",
        label: "sync_resolve",
        fork,
      });
      expect(readFileSync(join(workdir, "sync_resolve.out.log"), "utf8")).toBe(
        "sync_resolve ok: merged cleanly\n",
      );
    } finally {
      gw.stop();
    }
  });

  // Python line 1296: the audit file keeps the ORIGINAL prompt, not the
  // workdir-prefixed one the agent receives.
  test("audits the original prompt and leaves no out.log on failure", async () => {
    const gw = fakeGateway(() => raw("nope", 500));
    const workdir = tempDir("agent-sync-");
    try {
      const r = await new AgentClient({ baseUrl: gw.baseUrl, key: KEY }).runSync({
        workdir,
        prompt: "original prompt",
        label: "sync_quality",
        fork,
      });
      expect(r.ok).toBe(false);
      expect(readFileSync(join(workdir, "sync_quality.prompt.txt"), "utf8")).toBe("original prompt");
      expect(existsSync(join(workdir, "sync_quality.out.log"))).toBe(false);
    } finally {
      gw.stop();
    }
  });

  // Python line 1294: a dry run still calls the API but skips the prompt file.
  test("dry=true skips the prompt file and still posts", async () => {
    const gw = fakeGateway(() => choices("ok"));
    const workdir = tempDir("agent-sync-");
    try {
      const r = await new AgentClient({ baseUrl: gw.baseUrl, key: KEY }).runSync({
        workdir,
        prompt: "p",
        label: "sync_dry",
        fork,
        dry: true,
      });
      expect(r.ok).toBe(true);
      expect(existsSync(join(workdir, "sync_dry.prompt.txt"))).toBe(false);
      expect(gw.seen).toHaveLength(1);
    } finally {
      gw.stop();
    }
  });
});

// ── 8. Defaults ──────────────────────────────────────────────────────────────

describe("AgentClient defaults", () => {
  // Python line 80 / 988 / 75. These three constants are the tick's budget, so
  // they are pinned rather than left to drift.
  test("exposes the Python gateway URL, sync timeout and max turns", () => {
    expect(DEFAULT_API_SERVER_URL).toBe("http://127.0.0.1:8642/v1");
    expect(SYNC_CLAUDE_TIMEOUT).toBe(3600);
    expect(AI_FIX_MAX_TURNS).toBe(100);
  });

  // Python line 1213: `os.environ.get("API_SERVER_URL", "") or API_SERVER_URL`,
  // read per call so a changed env takes effect without a restart.
  test("honours API_SERVER_URL from the environment", async () => {
    const gw = fakeGateway(() => choices("ok"));
    process.env.API_SERVER_URL = gw.baseUrl;
    try {
      const r = await new AgentClient({ key: KEY }).post("p");
      expect(r.ok).toBe(true);
      expect(gw.seen[0].path).toBe("/v1/chat/completions");
    } finally {
      gw.stop();
    }
  });

  // Ruling 4: exactly one POST per call. A retry loop would double the 3600s
  // worst-case tick.
  test("makes exactly one request per post, even when it fails", async () => {
    const gw = fakeGateway(() => raw("boom", 503));
    try {
      await client(gw.baseUrl).post("p");
      expect(gw.seen).toHaveLength(1);
    } finally {
      gw.stop();
    }
  });
});

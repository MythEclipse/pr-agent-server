import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startHttpStub } from "./helpers/http-stub.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyReview, postDiscordOps, PR_AGENT_NOTIFY_URL } from "../src/discord.ts";

// ── Hermeticity ──────────────────────────────────────────────────────────────
//
// The real ~/.hermes/.ops-webhooks.json holds a LIVE Discord webhook, and
// ~/.env can hold real secrets. Every test points HERMES_HOME and HOME at temp
// dirs, and the webhook URL is a loopback Bun.serve (or a `.invalid` host that
// is never resolved), so a test can neither read a host secret nor post to the
// real channel.
let realHermesHome: string | undefined;
let realHome: string | undefined;
let realNotifyUrl: string | undefined;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "discord-home-"));
  mkdirSync(join(home, ".hermes"), { recursive: true });
  realHermesHome = process.env.HERMES_HOME;
  realHome = process.env.HOME;
  realNotifyUrl = process.env.PR_AGENT_NOTIFY_URL;
  process.env.HOME = home;
  process.env.HERMES_HOME = join(home, ".hermes");
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("HERMES_HOME", realHermesHome);
  restore("HOME", realHome);
  restore("PR_AGENT_NOTIFY_URL", realNotifyUrl);
});

const writeWebhooks = (cfg: unknown) =>
  writeFileSync(
    join(process.env.HERMES_HOME!, ".ops-webhooks.json"),
    typeof cfg === "string" ? cfg : JSON.stringify(cfg),
  );

type Call = { url: string; body: any };

/** Loopback webhook receiver. Returns the recorded calls plus a stopper. */
async function fakeWebhook(status = 204): Promise<{ url: string; calls: Call[]; stop: () => void }> {
  const calls: Call[] = [];
  const stub = await startHttpStub(async (req) => {
    calls.push({ url: new URL(req.url).pathname, body: await req.json() });
    return status === 200 ? new Response("ok", { status }) : new Response(null, { status });
  });
  return {
    url: `${stub.url}/api/webhooks/fake/pr-agent-ops`,
    calls,
    stop: () => void stub.close(),
  };
}

// ── postDiscordOps ───────────────────────────────────────────────────────────

describe("postDiscordOps", () => {
  // Python lines 1039-1050: read the ops config, look up "pr-agent-ops", post
  // one embed, and return whether the status was 200 or 204.
  test("posts the embed to the pr-agent-ops webhook", async () => {
    const wh = await fakeWebhook();
    try {
      writeWebhooks({ "pr-agent-ops": wh.url });
      expect(await postDiscordOps("Sync done", ["a", "b"])).toBe(true);
      expect(wh.calls).toHaveLength(1);
      const body = wh.calls[0].body;
      expect(body.username).toBe("PR-Agent Ops");
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0].title).toBe("Sync done");
      expect(body.embeds[0].description).toBe("a\nb");
      expect(body.embeds[0].color).toBe(0x5865f2);
    } finally {
      wh.stop();
    }
  });

  test("honours a custom colour", async () => {
    const wh = await fakeWebhook();
    try {
      writeWebhooks({ "pr-agent-ops": wh.url });
      await postDiscordOps("Warn", ["x"], 0xff0000);
      expect(wh.calls[0].body.embeds[0].color).toBe(0xff0000);
    } finally {
      wh.stop();
    }
  });

  // Python line 1048: `"\n".join(lines)[:4000]` — Discord drops an embed over
  // 4000 characters, which would silence the whole report.
  test("truncates the description to 4000 characters", async () => {
    const wh = await fakeWebhook();
    try {
      writeWebhooks({ "pr-agent-ops": wh.url });
      await postDiscordOps("Long", ["x".repeat(5000)]);
      expect(wh.calls[0].body.embeds[0].description).toHaveLength(4000);
    } finally {
      wh.stop();
    }
  });

  // Python line 1050: only 200/204 count as delivered.
  test.each([200, 204])("returns true for HTTP %i", async (status) => {
    const wh = await fakeWebhook(status);
    try {
      writeWebhooks({ "pr-agent-ops": wh.url });
      expect(await postDiscordOps("t", ["l"])).toBe(true);
    } finally {
      wh.stop();
    }
  });

  test.each([201, 302, 400, 429, 500])("returns false for HTTP %i", async (status) => {
    const wh = await fakeWebhook(status);
    try {
      writeWebhooks({ "pr-agent-ops": wh.url });
      expect(await postDiscordOps("t", ["l"])).toBe(false);
    } finally {
      wh.stop();
    }
  });

  // Python lines 1042-1043: no URL configured is not an error, just no-op.
  test("returns false without sending when the key is absent", async () => {
    const wh = await fakeWebhook();
    try {
      writeWebhooks({ "something-else": wh.url });
      expect(await postDiscordOps("t", ["l"])).toBe(false);
      expect(wh.calls).toHaveLength(0);
    } finally {
      wh.stop();
    }
  });

  // Every failure mode degrades to false: a missing file, malformed JSON, a
  // permissions error, or an unreachable webhook must never throw out of a
  // cron tick.
  test.each([
    ["a missing config file", () => {}],
    ["malformed JSON", () => writeWebhooks("{not json")],
    ["a JSON array instead of an object", () => writeWebhooks("[]")],
    ["a non-string webhook value", () => writeWebhooks({ "pr-agent-ops": 42 })],
  ])("returns false for %s", async (_label, setup) => {
    setup();
    expect(await postDiscordOps("t", ["l"])).toBe(false);
  });

  test("returns false when the webhook is unreachable", async () => {
    const wh = await fakeWebhook();
    const url = wh.url;
    wh.stop();
    writeWebhooks({ "pr-agent-ops": url });
    expect(await postDiscordOps("t", ["l"])).toBe(false);
  });
});

// ── notifyReview ─────────────────────────────────────────────────────────────

describe("notifyReview", () => {
  // Python lines 472-483: fire-and-forget POST to the server's internal
  // endpoint, timeout 5s, every exception swallowed.
  test("posts the review payload and returns without throwing", async () => {
    const seen: { path: string; method: string; body: any }[] = [];
    const server = await startHttpStub(async (req) => {
      seen.push({
        path: new URL(req.url).pathname,
        method: req.method,
        body: await req.json(),
      });
      return new Response("", { status: 200 });
    });
    process.env.PR_AGENT_NOTIFY_URL = `${server.url}/api/v1/notify_review`;
    try {
      await expect(
        notifyReview("o/repo", 42, "approved", "looks good", 9, "https://github.com/o/repo/pull/42"),
      ).resolves.toBeUndefined();
      expect(seen).toHaveLength(1);
      expect(seen[0].path).toBe("/api/v1/notify_review");
      expect(seen[0].method).toBe("POST");
      expect(seen[0].body).toEqual({
        repo: "o/repo",
        pr: 42,
        status: "approved",
        summary: "looks good",
        score: "9",
        url: "https://github.com/o/repo/pull/42",
      });
    } finally {
      await server.close();
    }
  });

  // Python line 480: `summary[:500]`, and the score is stringified even when a
  // number is passed (`str(score)`).
  test("truncates the summary to 500 characters and stringifies the score", async () => {
    const seen: any[] = [];
    const server = await startHttpStub(async (req) => {
      seen.push(await req.json());
      return new Response("", { status: 200 });
    });
    process.env.PR_AGENT_NOTIFY_URL = `${server.url}/api/v1/notify_review`;
    try {
      await notifyReview("o/repo", 7, "changes", "s".repeat(900), 8.5, "");
      const body = seen[0] as Record<string, unknown>;
      expect(body.summary).toHaveLength(500);
      expect(body.summary).toBe("s".repeat(500));
      expect(body.score).toBe("8.5");
    } finally {
      await server.close();
    }
  });

  test("resolves even when the notify endpoint is down", async () => {
    const server = await startHttpStub(() => new Response(""));
    const url = `${server.url}/api/v1/notify_review`;
    await server.close();
    process.env.PR_AGENT_NOTIFY_URL = url;
    await expect(notifyReview("o/repo", 1, "x", "s", "1", "")).resolves.toBeUndefined();
  });

  // The default is the server's loopback endpoint; pinning it stops a stray env
  // value from redirecting the test's expectations.
  test("defaults to the local pr-agent notify endpoint", () => {
    expect(PR_AGENT_NOTIFY_URL).toBe("http://127.0.0.1:4023/api/v1/notify_review");
  });
});

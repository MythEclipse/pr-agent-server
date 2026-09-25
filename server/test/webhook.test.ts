import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { handleWebhook, type WebhookEnv } from "../src/http/webhook";
import { loadConfig } from "../src/config";

const env: WebhookEnv = {
  cfg: loadConfig(), privateKeyPem: "", webhookSecret: "s3cret",
  analyticsDir: "", discordWebhookUrl: "", discordAlertWebhookUrl: "",
};
const sign = (b: string) => "sha256=" + createHmac("sha256", "s3cret").update(b).digest("hex");

describe("webhook", () => {
  test("rejects a bad signature with 403", async () => {
    const r = await handleWebhook(env, "{}", "sha256=deadbeef", "pull_request", { enqueue: () => {} });
    expect(r.status).toBe(403);
  });
  test("rejects a missing signature with 403", async () => {
    const r = await handleWebhook(env, "{}", null, "pull_request", { enqueue: () => {} });
    expect(r.status).toBe(403);
  });
  test("ignores non-pull_request events with 200", async () => {
    const body = JSON.stringify({ zen: "hi" });
    const r = await handleWebhook(env, body, sign(body), "ping", { enqueue: () => {} });
    expect(r).toEqual({ status: 200, body: { ok: true, ignored: true } });
  });
  test("ignores draft PRs", async () => {
    const body = JSON.stringify({
      action: "opened",
      pull_request: { number: 5, state: "open", draft: true, url: "https://api.github.com/repos/o/r/pulls/5" },
    });
    const r = await handleWebhook(env, body, sign(body), "pull_request", { enqueue: () => {} });
    expect(r.body).toEqual({ ok: true, ignored: true });
  });
  test("enqueues an open non-draft PR and answers fast", async () => {
    const jobs: unknown[] = [];
    const body = JSON.stringify({
      action: "opened",
      pull_request: { number: 7, state: "open", draft: false, url: "https://api.github.com/repos/o/r/pulls/7" },
    });
    const r = await handleWebhook(env, body, sign(body), "pull_request", { enqueue: (j: unknown) => { jobs.push(j); } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, triggered: true });
    expect(jobs).toEqual([{ owner: "o", repo: "r", pr: 7 }]);
  });
});
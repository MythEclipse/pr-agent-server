// HTTP server: Bun.serve route table + the in-process review queue worker.

import type { Server } from "bun";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config";
import { sendDiscord } from "../notify/discord";
import { runReview } from "../tools/review";
import { analyticsRoutes } from "./analytics";
import { notifyReviewFailure, notifyReviewSuccess } from "./notify";
import { setupCallback } from "./setup";
import { handleWebhook, type ReviewJob, type ReviewQueue, type WebhookEnv } from "./webhook";
// Bun's Server type is generic over WebSocketData since Bun 1.3; our routes
// declare no websocket handlers, so undefined is the natural shape.
export type AppServer = Server<undefined>;

function readPrivateKey(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export function startServer(env?: Partial<WebhookEnv>): AppServer {
  const cfg = env?.cfg ?? loadConfig();
  const appDir = process.env.PR_AGENT_APP_DIR || "/var/lib/pr-agent-server";
  const privateKeyPem =
    env?.privateKeyPem ??
    (readPrivateKey(process.env.PRIVATE_KEY_PATH || `${appDir}/private-key.pem`) ||
      readPrivateKey(`${appDir}/private-key.pem`) ||
      "");
  const webhookSecret =
    env?.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const analyticsDir =
    env?.analyticsDir ?? (process.env.PR_AGENT_ANALYTICS_DIR || "/var/lib/pr-agent-server/analytics");
  const discordWebhookUrl =
    env?.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL ?? "";
  const discordAlertWebhookUrl =
    env?.discordAlertWebhookUrl ?? process.env.DISCORD_ALERT_WEBHOOK_URL ?? "";

  const fullEnv: WebhookEnv = {
    cfg,
    privateKeyPem,
    webhookSecret,
    analyticsDir,
    discordWebhookUrl,
    discordAlertWebhookUrl,
  };

  // Minimal serial in-process review queue: one review at a time, so a burst of
  // webhooks cannot stampede the LLM. `enqueue` only pushes a job and kicks the
  // worker off with `void` — the webhook response never waits on a review.
  // Task 6 replaces this with the dedupe queue (src/queue.ts).
  const jobs: ReviewJob[] = [];
  let working = false;
  const drain = async (): Promise<void> => {
    if (working) return;
    working = true;
    try {
      while (jobs.length > 0) {
        const job = jobs.shift()!;
        try {
          const result = await runReview(fullEnv.cfg, job.owner, job.repo, job.pr, fullEnv.privateKeyPem);
          await notifyReviewSuccess(fullEnv, job, result);
        } catch (e) {
          await notifyReviewFailure(fullEnv, job, e);
        }
      }
    } finally {
      working = false;
    }
  };
  const queue: ReviewQueue = {
    enqueue(job: ReviewJob) {
      jobs.push(job);
      void drain();
      return job;
    },
  };

  const server = Bun.serve({
    port: Number(process.env.PORT || 3000),
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", model: cfg.model });
      }
      const setup = await setupCallback(url, appDir);
      if (setup) return setup;
      if (url.pathname === "/api/v1/github_webhooks" || url.pathname === "/") {
        if (req.method !== "POST") {
          return Response.json({ ok: true });
        }
        const body = await req.text();
        const sig = req.headers.get("x-hub-signature-256");
        const event = req.headers.get("x-github-event") || "";
        const result = await handleWebhook(fullEnv, body, sig, event, queue);
        return Response.json(result.body, { status: result.status });
      }
      if (url.pathname === "/api/v1/notify_review") {
        if (req.method !== "POST") {
          return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
        }
        try {
          const body = (await req.json()) as {
            repo?: string; pr?: string | number; status?: string;
            summary?: string; score?: string; url?: string;
          };
          const repo = body.repo || "";
          const prNum = String(body.pr ?? "");
          const status = body.status || "done";
          const summary = String(body.summary || "");
          const score = String(body.score || "");
          const url = String(body.url || "");
          const content = `Review ${status} for ${repo}#${prNum}` +
            (score ? ` — score ${score}` : "") + `\n${summary}\n${url}`;
          if (fullEnv.discordWebhookUrl) {
            void sendDiscord(fullEnv.discordWebhookUrl, content).catch(() => {});
          } else {
            console.log(`[notify] ${repo}#${prNum} ${status} ${score} ${url}`);
          }
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, error: String(e) }, { status: 400 });
        }
      }
      const analytics = analyticsRoutes(url, fullEnv);
      if (analytics) return analytics;
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  console.log(`PR-Agent Bun server listening on :${server.port}`);
  return server;
}

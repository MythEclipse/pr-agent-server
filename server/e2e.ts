// E2E test harness — runs the full review pipeline against the REAL GitHub
// App + 9router. Not part of `bun test` (needs secrets); run explicitly.
//
//   bun e2e --repo <owner/repo> --pr <number>
//
// Validates: GitHub App auth (JWT+installation token), diff fetch, token
// budget, prompt render, LLM call via 9router, YAML parse, markdown render.
// Does NOT publish a comment unless --publish is passed.

import { readFileSync } from "node:fs";
import { loadConfig } from "./src/config";
import { GitHubProvider } from "./src/github";
import { runReview } from "./src/tools/review";
import { countTokens } from "./src/core/token";

const args = process.argv.slice(2);
const repoArg = args[args.indexOf("--repo") + 1];
const prArg = Number(args[args.indexOf("--pr") + 1]);
const publish = args.includes("--publish");

if (!repoArg || !prArg) {
  console.error("usage: bun e2e --repo owner/repo --pr N [--publish]");
  process.exit(2);
}

const cfg = loadConfig();
const appDir = process.env.PR_AGENT_APP_DIR ?? "/var/lib/pr-agent-server";
let privateKey = "";
const keyCandidates = [
  `${appDir}/private-key.pem`,
  `${process.env.HOME ?? "/home/code"}/.hermes/keys/pr-agent-key.pem`,
];
for (const p of keyCandidates) {
  try {
    privateKey = readFileSync(p, "utf8");
    break;
  } catch {
    // try next
  }
}
if (!privateKey) throw new Error(`private-key.pem not found in ${keyCandidates.join(", ")}`);

const gh = new GitHubProvider(cfg, repoArg.split("/")[0], repoArg.split("/")[1], prArg, privateKey);

const startedAt = Date.now();
console.log(`\n=== E2E review ${repoArg}#${prArg} (publish=${publish}) ===`);

// sanity: hitting the GitHub API to prove App auth works before the long LLM call
try {
  const pr = await gh.getPr();
  console.log(`PR ${pr.number}: "${pr.title}" (${pr.additions}+ / ${pr.deletions}-, ${pr.changedFiles} files)`);
} catch (err) {
  console.error("GitHub App auth / PR fetch failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}

try {
  const res = await runReview(
    cfg,
    repoArg.split("/")[0],
    repoArg.split("/")[1],
    prArg,
    privateKey,
    { publish },
  );
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== DONE in ${elapsed}s ===`);
  console.log("status:", res.status);
  if (res.markdown) {
    console.log(`comment length: ${res.markdown.length} chars`);
    console.log(`comment tokens: ${countTokens(res.markdown)}`);
    console.log("--- comment head ---");
    console.log(res.markdown.slice(0, 600));
    console.log("--- comment tail ---");
    console.log(res.markdown.slice(-600));
  } else {
    console.log("WARNING: markdown is empty/missing");
    console.log("markdown present:", !!res.markdown, "| data present:", !!res.data);
  }
  console.log("model:", res.model, "| promptTokens:", res.promptTokens, "| completionTokens:", res.completionTokens);
  process.exit(res.status === "success" ? 0 : 1);
} catch (err) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`\n=== FAILED after ${elapsed}s ===`);
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
}
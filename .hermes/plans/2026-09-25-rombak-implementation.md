# Rombak + Migrasi Penuh pr-agent-server ke TS/Bun — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rombak `pr-agent-server` jadi dua paket TypeScript/Bun yang terstruktur
(server webhook + worker cron), dan migrasikan seluruh Python (`pr-queue-worker.py`,
`test_pr_queue_sync.py`, `smoke_hermes_api_server.py`, `pr-ops-notifier.py`,
`pr-ai-fixer.py`) ke TS tanpa kehilangan perilaku produksi.

**Architecture:** `server/` = webhook GitHub App → antrian in-process (dedupe per
`repo#pr#sha`) → tools review/describe/improve → publish + analytics + Discord.
`worker/` = cron 5 menit: scan PR → trigger review → AI fix (via gateway Hermes) →
safety → CI → approve/merge, plus upstream fork sync. Satu bahasa, satu runner tes
(`bun test`), state `/tmp/*.json` formatnya tidak berubah.

**Tech Stack:** Bun 1.3.14, TypeScript strict, `bun:test`, `@octokit/auth-app` +
`@octokit/rest`, `js-tiktoken`, `nunjucks`, `yaml`, `node:crypto` (HMAC + RS256 JWT),
`Bun.spawn` (git), `Bun.serve` (server tes), `fetch` (httpx diganti).

**Spec:** `.hermes/plans/2026-09-25-rombak-arsitektur.md`

## Global Constraints

- Runtime: **Bun 1.3.14**; TypeScript `strict: true`; `bunx tsc --noEmit` wajib bersih.
- Tes: `bun:test` saja. Tidak ada vitest/jest.
- Port tidak berubah: server `:4023`, `/health`, `/api/v1/github_webhooks`,
  `/api/v1/notify_review`, `/api/metrics`, `/api/analytics`, `/setup/callback`.
- State file **format JSON identik**: `/tmp/pr-queue-worker.lock`,
  `/tmp/pr-queue-fix-state.json`, `/tmp/pr-queue-sync-state.json`, workdir
  `/tmp/pr-queue-work/`, `/tmp/pr-queue-sync-work/`.
- Bot login `mytheclipsebotreview`; App ID default `4319749`.
- Safety merge threshold: score **≥ 6** dari 10.
- Upstream sync: interval **1.0 jam**, `max_per_tick` **2**, `SYNC_CLAUDE_TIMEOUT`
  **3600s**, `AI_FIX_TIMEOUT` **1800s**, `AI_FIX_MAX_TURNS` **100**.
- Commit message AI fix **persis**: `fix: auto-fix code quality [skip ci]`
  (tanpa `[skip ci]` untuk sync bun.lock: `chore: sync bun.lock after dependabot bump`).
- Secrets: TIDAK pernah hardcode. Dari env + `~/.hermes/.env` + file di
  `/var/lib/pr-agent-server` (`private-key.pem`, `omniroute_key`).
- File logika ≤ 400 baris (kecuali `prompts/` data).
- Semua error tak terduga di jalur produksi harus menghasilkan string berawalan
  `[INFRA]` (worker) agar skip-once bekerja.

## Review Focus

1. **Timeout agent tapi merge sudah selesai** (sync conflict, 17 file ≈ 16 menit):
   harus diselamatkan (`salvage`), bukan di-abort. → Task 15.
2. **State `/tmp` rusak/terpotong** saat ditulis: load harus toleran (shape kosong),
   tidak crash, tidak menghapus riwayat. → Task 8.
3. **Burst webhook** (worker fabricate tiap 5 menit + event asli): review ganda /
   comment dobel. → Task 6.
4. **Push protected branch** dan **CI merah di merge commit sendiri**: harus fallback
   buka PR, dan revert hanya kalau commit kita masih tip. → Task 15.
5. **Prompt yang dirender** untuk variabel sama harus byte-identik dengan versi
   sekarang (kalau tidak, kualitas review berubah diam-diam). → Task 5.

---

## FASE 1 — Server: struktur modul

### Task 1: `core/` — ekstraksi token, render, yaml, markdown

**Files:**
- Create: `server/src/core/token.ts`, `server/src/core/render.ts`,
  `server/src/core/yaml.ts`, `server/src/core/markdown.ts`
- Delete: `server/src/token.ts`, `server/src/render.ts`, `server/src/yaml.ts`,
  `server/src/markdown.ts`
- Modify: `server/src/review.ts`, `server/src/describe.ts`, `server/src/improve.ts`,
  `server/test/review.test.ts` (import path saja)
- Test: `server/test/review.test.ts` (existing, dipindah importnya)

**Interfaces:**
- Consumes: —
- Produces: `countTokens(text: string): number`,
  `countPromptTokens(system: string, user: string, vars: Record<string, unknown>, render: (t: string, d: Record<string, unknown>) => string): number`
  dari `core/token.ts`; `renderTemplate(template: string, data: Record<string, unknown>): string`
  dari `core/render.ts`; `loadYaml(responseText: string, keysFixYaml?: string[], firstKey?: string, lastKey?: string): Record<string, unknown> | null`
  dari `core/yaml.ts`; `convertToMarkdownV2(outputData: { review: Record<string, unknown> }, gfmSupported?: boolean, enableIntroText?: boolean): string`
  dari `core/markdown.ts`.

- [ ] **Step 1: Pindahkan file dengan `git mv`**

```bash
cd /home/code/pr-agent-server/server
mkdir -p src/core
git mv src/token.ts src/core/token.ts
git mv src/render.ts src/core/render.ts
git mv src/yaml.ts src/core/yaml.ts
git mv src/markdown.ts src/core/markdown.ts
```

- [ ] **Step 2: Hapus kode mati di `render.ts`**

Hapus `renderTemplateTolerant` (tidak dipakai — grep: 0 call site). Sisakan
`getEnv` + `renderTemplate`.

- [ ] **Step 3: Update import di semua konsumen**

```bash
grep -rn 'from "./token"\|from "./render"\|from "./yaml"\|from "./markdown"' src test
# ganti menjadi "./core/token" dst (test: "../src/core/token")
```

- [ ] **Step 4: Jalankan tes + typecheck**

Run: `cd server && bunx tsc --noEmit && bun test`
Expected: PASS 16 tes, tsc bersih.

- [ ] **Step 5: Commit**

```bash
git add -A server/src server/test
git commit -m "refactor(server): extract core/ (token, render, yaml, markdown)"
```

---

### Task 2: `diff/` — pecah 711 baris + perbaiki sorting bahasa (S8)

**Files:**
- Create: `server/src/diff/hunk.ts`, `server/src/diff/extend.ts`,
  `server/src/diff/filter.ts`, `server/src/diff/budget.ts`, `server/src/diff/multi.ts`,
  `server/src/diff/index.ts` (re-export)
- Delete: `server/src/diff.ts`
- Modify: `server/src/review.ts`, `server/src/describe.ts`, `server/src/improve.ts`,
  `server/src/github.ts`, `server/test/review.test.ts`
- Test: `server/test/diff-langs.test.ts` (baru)

**Interfaces:**
- Consumes: `countTokens` dari `core/token`; `Config` dari `config`.
- Produces (dari `diff/index.ts`, semua nama lama dipertahankan):
  `EditType`, `FilePatchInfo`, `parseHunkHeader`, `omitDeletionHunks`,
  `handlePatchDeletions`, `extendPatch`, `decoupleAndConvertToHunksWithLinesNumbers`,
  `generateFullPatch`, `getPrDiff(files, promptTokens, model, cfg, languages?): PrDiffResult`,
  `getPrMultiDiffs(files, promptTokens, model, cfg, maxCalls?, addLineNumbers?): { chunks: string[]; chunksNoLineNumbers: string[] }`,
  `clipTokens`, `isGeneratedOrInvalidFile`, `shouldSkipPatch`, `sortFilesByMainLanguages`.

- [ ] **Step 1: Tulis tes yang GAGAL untuk sorting bahasa (bug S8)**

`server/test/diff-langs.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { getPrDiff, EditType, type FilePatchInfo } from "../src/diff";
import { loadConfig } from "../src/config";

const file = (filename: string, patch: string): FilePatchInfo => ({
  filename, baseFile: "a\nb\nc\n", headFile: "a\nB\nc\n", patch,
  editType: EditType.MODIFIED, numPlusLines: 1, numMinusLines: 1,
});

describe("getPrDiff language ordering", () => {
  test("main-language files come first when languages are supplied", () => {
    const cfg = loadConfig();
    const files = [
      file("docs/readme.md", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"),
      file("src/app.py", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"),
    ];
    const { diff } = getPrDiff(files, 0, "claude-opus-5", cfg, { Python: 9000, Markdown: 10 });
    expect(diff.indexOf("src/app.py")).toBeLessThan(diff.indexOf("docs/readme.md"));
  });
});
```

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd server && bun test test/diff-langs.test.ts`
Expected: FAIL — `getPrDiff` masih 4 argumen (`languages` diabaikan) sehingga urutan
file tetap `docs/readme.md` dulu.

- [ ] **Step 3: Pecah `diff.ts` jadi 5 modul**

- `hunk.ts`: `RE_HUNK_HEADER`, `HunkHeader`, `parseHunkHeader`, `omitDeletionHunks`,
  `handlePatchDeletions`, `decoupleAndConvertToHunksWithLinesNumbers`
- `extend.ts`: `MAX_EXTRA_LINES`, `extendPatch`, `arraysEqual`, `checkHunkLinesMatch`
- `filter.ts`: `AUTO_GENERATED_EXACT`, `AUTO_GENERATED_SUFFIXES`, `BAD_EXTENSIONS`,
  `isGeneratedOrInvalidFile`, `shouldSkipPatch`
- `budget.ts`: `DELETED_FILES_` dkk, `generateFullPatch`, `getPrDiff`, `clipTokens`,
  `getModelTokenLimitLocal` **dihapus** → pakai `getModelTokenLimit` dari `config`
  (menghapus duplikasi S6)
- `multi.ts`: `getPrMultiDiffs`, `sortFilesByMainLanguages`
- `index.ts`: `export * from "./hunk"` dst (urutan ekspor eksplisit untuk nama
  `FilePatchInfo`/`EditType` yang tinggal di `hunk.ts`)

- [ ] **Step 4: Perbaiki S8 — teruskan bahasa ke `getPrDiff`**

`getPrDiff(files, promptTokens, model, cfg, languages = {})`: panggil
`sortFilesByMainLanguages(languages, files)` di awal, lalu proses hasil sortir.
Di `review.ts` buang `getPrDiffWithFiles` + `vars["_langs"]` dan panggil
`getPrDiff(sortedInput, promptTokens, cfg.model, cfg, languages)` dengan `languages`
yang sudah diambil dari `provider.getLanguages()`.

- [ ] **Step 5: Jalankan tes + typecheck**

Run: `cd server && bunx tsc --noEmit && bun test`
Expected: PASS — tes baru lulus, 16 tes lama tetap lulus.

- [ ] **Step 6: Commit**

```bash
git add -A server/src server/test
git commit -m "refactor(server): split diff/ into hunk/extend/filter/budget/multi + fix lang ordering"
```

---

### Task 3: `github/` — client + provider, perbaiki S9 & S10

**Files:**
- Create: `server/src/github/client.ts`, `server/src/github/provider.ts`,
  `server/src/github/index.ts`
- Delete: `server/src/github.ts`
- Modify: konsumen (`review.ts`, `describe.ts`, `improve.ts`, `index.ts`)
- Test: `server/test/github-auth.test.ts` (baru)

**Interfaces:**
- Produces: `class GitHubProvider` (nama & method persis seperti sekarang) dari
  `github/provider.ts`; `class AppAuthClient` dengan
  `token(): Promise<string>` (cached, refresh 60s sebelum expiry) dari `github/client.ts`.
- Consumes: `Config`, `FilePatchInfo`/`EditType`/`isGeneratedOrInvalidFile`.

- [ ] **Step 1: Tulis tes GAGAL untuk header auth (S10)**

`server/test/github-auth.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildAuthHook } from "../src/github/client";

describe("installation token auth hook", () => {
  test("injects Bearer header synchronously from a cached token", () => {
    const seen: Record<string, string> = {};
    const hook = buildAuthHook(() => "tok_123");
    hook((opts: { headers: Record<string, string> }) => {
      Object.assign(seen, opts.headers);
      return Promise.resolve("ok");
    }, { headers: {} });
    expect(seen.authorization).toBe("Bearer tok_123");
  });

  test("never sends a request without an authorization header", async () => {
    const calls: { headers: Record<string, string> }[] = [];
    const hook = buildAuthHook(() => "tok_456");
    await hook((opts: { headers: Record<string, string> }) => {
      calls.push(opts);
      return Promise.resolve("ok");
    }, { headers: {} });
    expect(calls.length).toBe(1);
    expect(calls[0].headers.authorization).toBe("Bearer tok_456");
  });
});
```

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd server && bun test test/github-auth.test.ts`
Expected: FAIL — `buildAuthHook` belum ada (modul `github/client` belum dibuat).

- [ ] **Step 3: Implementasi `client.ts`**

```ts
export type TokenGetter = () => string;

export function buildAuthHook(getToken: TokenGetter) {
  return (request: (opts: { headers: Record<string, string> }) => Promise<unknown>,
          options: { headers?: Record<string, string> }) => {
    options.headers = options.headers ?? {};
    options.headers.authorization = `Bearer ${getToken()}`;
    return request(options as { headers: Record<string, string> });
  };
}
```

`AppAuthClient`: `constructor(cfg, privateKeyPem)`; `installationToken(owner, repo)`
memakai `createAppAuth({ appId, privateKey })` → `{type:"installation", installationId}`,
cache token + `expiresAt`, refresh kalau `< 60s`. **Prefetch**: `provider.ts`
memanggil `await client.installationToken()` di awal setiap method publik (bukan lagi
7× `ensureInstallationToken`), sehingga hook selalu punya token saat request pertama.

- [ ] **Step 4: Implementasi `provider.ts` + perbaiki S9**

- `publishPersistentComment(content, initialHeader, name, finalUpdateMessage)`:
  ganti `const updated = c.body ? content.replace(initialHeader, updatedHeader) : content;`
  menjadi `const updated = content.replace(initialHeader, updatedHeader);`
  (selalu pakai konten baru; `c.body` tidak relevan).
- Hapus `ensureInstallationToken` publik; sisakan `private ensureToken()`.
- Pertahankan `getLineLink` (SHA-256 anchor), `updateDescription`, `addLabels`,
  `getLabels`, `removeInitialComment`, `retry` (hanya 403/429/rate limit).

- [ ] **Step 5: Jalankan tes + typecheck**

Run: `cd server && bunx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A server/src server/test
git commit -m "refactor(server): split github/ client+provider, fix token race and persistent comment"
```

---

### Task 4: `http/` + `analytics.ts` — pecah index.ts, analytics async (S3, S4)

**Files:**
- Create: `server/src/http/server.ts`, `server/src/http/webhook.ts`,
  `server/src/http/notify.ts`, `server/src/http/analytics.ts`,
  `server/src/http/setup.ts`, `server/src/analytics.ts`,
  `server/src/notify/discord.ts`
- Delete: `server/src/index.ts` (diganti `server/src/main.ts`)
- Create: `server/src/main.ts` (entry: `if (import.meta.main) startServer()`)
- Modify: `server/package.json` (`module`/`main`/`scripts` → `src/main.ts`),
  `server/src/cli.ts` (import analytics dari `./analytics`),
  `server/e2e.ts`, `.github/workflows/deploy.yml` (entry `src/main.ts`)
- Test: `server/test/webhook.test.ts` (baru), `server/test/analytics.test.ts` (baru)

**Interfaces:**
- Produces: `interface WebhookEnv { cfg: Config; privateKeyPem: string; webhookSecret: string; analyticsDir: string; discordWebhookUrl: string; discordAlertWebhookUrl: string }`;
  `handleWebhook(env: WebhookEnv, body: string, signature: string | null, event: string, queue: { enqueue(job: {owner: string; repo: string; pr: number}): unknown }): Promise<{status: number; body: unknown}>`;
  `readAnalyticsLogs(dir: string, maxFiles?: number): AnalyticsRecord[]`;
  `appendAnalyticsEvent(dir: string, event: {message: string; extra: Record<string, unknown>}): void` (async, serialized);
  `generateMetrics(dir: string): string`; `startServer(env?: Partial<WebhookEnv>): Server`;
  `htmlToDiscordPlain(html: string): string`; `sendDiscord(url: string, content: string, title?: string): Promise<void>`.

- [ ] **Step 1: Tulis tes GAGAL untuk HMAC + ping**

`server/test/webhook.test.ts`:

```ts
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
```

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd server && bun test test/webhook.test.ts`
Expected: FAIL — `../src/http/webhook` belum ada.

- [ ] **Step 3: Pindahkan kode ke modul baru**

- `http/webhook.ts`: HMAC + parse + enqueue (logika `handleWebhook` sekarang, tanpa
  `runReview` langsung, tanpa Discord — itu tugas queue/analytics).
- `http/notify.ts`, `http/analytics.ts`, `http/setup.ts`: potong dari `index.ts`
  (`notify_review`, `/api/metrics` + `/api/analytics`, `/setup/callback`).
- `analytics.ts`: `readAnalyticsLogs` + `generateMetrics` (pindah apa adanya) +
  `appendAnalyticsEvent` **async** memakai `Bun.write(file, data, {createPath:false})`?
  → gunakan `await fs.promises.appendFile` dari `node:fs/promises` dengan antrian
  modul-level (`let chain = Promise.resolve()`) supaya urutan tetap dan event loop
  tidak diblokir. `logReviewEvent` lama dihapus (digantikan fungsi ini).
- `notify/discord.ts`: `htmlToDiscordPlain` + `sendDiscord` (pindah apa adanya).
- `http/server.ts`: `Bun.serve` + tabel route (port 4023/env PORT), health, wiring.
- Hapus kode mati: `awaitLocalFs`, `getHttpx`, `_discordClient`, `readPrivateKey`
  (pakai `readFileSync` import statis), semua `require("node:fs")` di ESM.

- [ ] **Step 4: Update entry point**

`server/src/main.ts`: `import { startServer } from "./http/server"; if (import.meta.main) startServer();`
Update `server/package.json` (`module`/`main`/`dev`/`start` → `src/main.ts`),
`server/e2e.ts` import `logReviewEvent` → `appendAnalyticsEvent`,
dan `deploy.yml` (`bun build --compile src/main.ts`).

- [ ] **Step 5: Tulis tes analytics shape + jalankan**

`server/test/analytics.test.ts`: tulis 2 baris log legacy ke tmpdir
(`{"text":"","record":{"time":{"repr":"...","timestamp":1},"level":{"name":"INFO"},"message":"Generated code suggestions","extra":{"command":"review","model":"claude-opus-5"}}}`),
lalu assert `readAnalyticsLogs(dir).length === 2`, `generateMetrics(dir)` memuat
`pr_agent_requests_total{status="success"} 2`, dan `appendAnalyticsEvent` menulis
baris yang bisa dibaca kembali (round-trip).

Run: `cd server && bunx tsc --noEmit && bun test`
Expected: PASS semua.

- [ ] **Step 6: Commit**

```bash
git add -A server
git commit -m "refactor(server): split http/ + async analytics, remove dead code"
```

---

### Task 5: `tools/` + `prompts/` + `llm.callWithFallback` + per-tool model

**Files:**
- Create: `server/src/tools/review.ts`, `server/src/tools/describe.ts`,
  `server/src/tools/improve.ts`, `server/src/tools/publish.ts`,
  `server/src/prompts/review.ts`, `server/src/prompts/describe.ts`,
  `server/src/prompts/suggestions.ts`
- Delete: `server/src/review.ts`, `server/src/describe.ts`, `server/src/improve.ts`,
  `server/src/prompts.ts`
- Modify: `server/src/llm.ts` (tambah `callWithFallback`), `server/src/config.ts`
  (model per tool + hapus jalur `secrets.ts`), `server/src/cli.ts`
- Delete: `server/src/secrets.ts` (key resolution pindah ke `config.ts`; `e2e.ts`
  diubah memakai `loadConfig()`)
- Test: `server/test/llm-fallback.test.ts`, `server/test/prompt-snapshot.test.ts`

**Interfaces:**
- Produces: `callWithFallback(opts: {models: string[]; system: string; user: string; temperature?: number; cfg: Config; retries?: number}): Promise<{content: string; model: string; usage: {promptTokens: number; completionTokens: number; cachedTokens: number}}>`;
  `runReview/runDescribe/runImprove` (signature sama seperti sekarang);
  `publishPersistent(provider, markdown, header, name, finalUpdateMessage): Promise<void>`.
- Consumes: `chatCompletion`, `GitHubProvider`, `getPrDiff`, `getPrMultiDiffs`, `loadYaml`, `convertToMarkdownV2`.

- [ ] **Step 1: Tulis tes GAGAL untuk retry per-model (B4)**

`server/test/llm-fallback.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { callWithFallback } from "../src/llm";
import { loadConfig } from "../src/config";

const cfg = loadConfig();

describe("callWithFallback", () => {
  test("retries a transient failure then succeeds on the same model", async () => {
    let n = 0;
    const fake = async () => {
      n++;
      if (n < 3) throw new Error("LLM request failed (503): upstream busy");
      return { content: "ok", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
    };
    const r = await callWithFallback({ models: ["m1"], system: "s", user: "u", cfg, retries: 2, call: fake });
    expect(r.content).toBe("ok");
    expect(r.model).toBe("m1");
    expect(n).toBe(3);
  });

  test("moves to the next model when the first keeps failing", async () => {
    const seen: string[] = [];
    const fake = async (o: { model: string }) => {
      seen.push(o.model);
      if (o.model === "m1") throw new Error("LLM request failed (500): boom");
      return { content: "ok2", finishReason: "stop", usage: {} };
    };
    const r = await callWithFallback({ models: ["m1", "m2"], system: "s", user: "u", cfg, retries: 0, call: fake });
    expect(r.model).toBe("m2");
    expect(seen).toEqual(["m1", "m2"]);
  });

  test("does not retry a 4xx client error", async () => {
    let n = 0;
    const fake = async () => { n++; throw new Error("LLM request failed (400): bad model"); };
    await expect(callWithFallback({ models: ["m1"], system: "s", user: "u", cfg, retries: 3, call: fake }))
      .rejects.toThrow(/All models failed/);
    expect(n).toBe(1);
  });
});
```

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd server && bun test test/llm-fallback.test.ts`
Expected: FAIL — `callWithFallback` belum ada.

- [ ] **Step 3: Implementasi `callWithFallback`**

```ts
export type ChatCall = (o: { model: string; system: string; user: string; temperature?: number; cfg: Config }) => Promise<ChatResult>;

const isTransient = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  if (/LLM request failed \((4\d\d)\)/.test(m)) return false;   // client error → jangan retry
  return /LLM request failed \(5\d\d\)|fetch failed|aborted|timeout|ECONN|socket/i.test(m);
};

export async function callWithFallback(opts: {
  models: string[]; system: string; user: string; temperature?: number;
  cfg: Config; retries?: number; call?: ChatCall;
}) {
  const call = opts.call ?? chatCompletion;
  const retries = opts.retries ?? 2;
  let last: unknown;
  for (const model of opts.models) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await call({ model, system: opts.system, user: opts.user, temperature: opts.temperature, cfg: opts.cfg });
        return { content: r.content, model, usage: { promptTokens: r.usage?.promptTokens ?? 0, completionTokens: r.usage?.completionTokens ?? 0, cachedTokens: r.usage?.cachedTokens ?? 0 } };
      } catch (e) {
        last = e;
        if (!isTransient(e) || attempt === retries) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }
  throw new Error(`All models failed: ${(last as Error)?.message ?? "unknown"}`);
}
```

- [ ] **Step 4: Model per tool di `config.ts`**

```ts
modelReview: env.PR_AGENT_MODEL_REVIEW || env.PR_AGENT_MODEL || "claude-opus-5",
modelDescribe: env.PR_AGENT_MODEL_DESCRIBE || env.PR_AGENT_MODEL || "claude-opus-5",
modelImprove: env.PR_AGENT_MODEL_IMPROVE || env.PR_AGENT_MODEL || "claude-opus-5",
```
`fallbackModels` tetap dipakai ketiganya. Hapus `secrets.ts`; `config.ts` tetap
satu-satunya tempat resolusi key (`OMNIROUTE_API_KEY` → `ANTHROPIC_API_KEY` →
`OPENAI_API_KEY` → file `omniroute_key`).

- [ ] **Step 5: Pindahkan prompts + tools, hapus duplikasi**

- `prompts.ts` (629 baris) dipecah 3 file; **isi template tidak diubah satu byte pun**.
- `tools/publish.ts`: satu `publishPersistent()` dipakai review/describe/improve
  (menggantikan 3 salinan pemanggilan `publishPersistentComment`).
- `tools/review.ts`: hapus `clipTokensSimple` → pakai `clipTokens` dari `diff/budget`;
  hapus `getModelTokenLimitLocal`; pakai `callWithFallback` dengan `cfg.modelReview`.
- `tools/describe.ts`: pakai `callWithFallback` + `cfg.modelDescribe`; hapus blok
  `try { link = provider.getLineLink(...) } catch { link = "" }` yang hasilnya selalu
  dibuang (`link = ""` setelah assign) — ganti dengan komentar kenapa link tidak
  dipakai di walkthrough.
- `tools/improve.ts`: pakai `callWithFallback` + `cfg.modelImprove` (paralel per chunk
  tetap `Promise.all`).

- [ ] **Step 6: Tulis tes snapshot prompt**

`server/test/prompt-snapshot.test.ts`: render `REVIEW_SYSTEM_TEMPLATE` +
`REVIEW_USER_TEMPLATE` dengan variabel contoh yang sama seperti
`test/review.test.ts` "review prompts render with real vars", lalu bandingkan
dengan string yang disimpan di `server/test/fixtures/review-prompt.snapshot.txt`
(dibuat dari kode SEKARANG, sebelum Task 5, dengan perintah di Step 7).

- [ ] **Step 7: Buat fixture snapshot DARI KODE LAMA (sebelum refactor ini)**

Jalankan sekali sebelum mengubah `review.ts`:

```bash
cd server && bun -e '
import { renderTemplate } from "./src/render";
import { REVIEW_SYSTEM_TEMPLATE, REVIEW_USER_TEMPLATE } from "./src/prompts";
const vars = { title: "T", branch: "b", description: "d", language: "TypeScript", diff: "DIFF",
  num_pr_files: 1, num_max_findings: 3, require_score: true, require_tests: true,
  require_estimate_effort_to_review: true, require_estimate_contribution_time_cost: false,
  require_can_be_split_review: false, require_security_review: true, require_todo_scan: false,
  question_str: "", answer_str: "", extra_instructions: "", skills_context: "", repo_context: "",
  commit_messages_str: "1. c", custom_labels: "", enable_custom_labels: false, is_ai_metadata: false,
  related_tickets: [], duplicate_prompt_examples: false, date: "2026-09-25" };
const out = renderTemplate(REVIEW_SYSTEM_TEMPLATE, vars) + "\n===USER===\n" + renderTemplate(REVIEW_USER_TEMPLATE, vars);
await Bun.write("test/fixtures/review-prompt.snapshot.txt", out);
' && wc -c test/fixtures/review-prompt.snapshot.txt
```

- [ ] **Step 8: Jalankan tes + typecheck**

Run: `cd server && bunx tsc --noEmit && bun test`
Expected: PASS semua, termasuk snapshot prompt.

- [ ] **Step 9: Commit**

```bash
git add -A server
git commit -m "refactor(server): split tools/ + prompts/, per-tool model, retry-with-fallback LLM"
```

---

### Task 6: `queue.ts` — antrian review dedupe + concurrency (B1, B2)

**Files:**
- Create: `server/src/queue.ts`
- Modify: `server/src/http/server.ts`, `server/src/http/webhook.ts`, `server/src/cli.ts`
- Test: `server/test/queue.test.ts`

**Interfaces:**
- Produces: `class ReviewQueue { constructor(opts: {concurrency?: number; run: (job: {owner: string; repo: string; pr: number}) => Promise<void>; log?: (m: string) => void}); enqueue(job: {owner: string; repo: string; pr: number}): "queued" | "deduped"; size(): number; drain(): Promise<void> }`
- Consumes: `runReview` (di-inject dari server, supaya tes tidak memanggil GitHub).

- [ ] **Step 1: Tulis tes GAGAL**

`server/test/queue.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ReviewQueue } from "../src/queue";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ReviewQueue", () => {
  test("dedupes the same repo+pr while a job is in flight", async () => {
    const ran: string[] = [];
    let release: () => void = () => {};
    const q = new ReviewQueue({ run: async (j) => { ran.push(`${j.repo}#${j.pr}`); await new Promise<void>((r) => (release = r)); } });
    expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("queued");
    expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("deduped");
    await tick();
    release();
    await q.drain();
    expect(ran).toEqual(["r#1"]);
  });

  test("re-runs after the job finished (new head may need a review)", async () => {
    const ran: string[] = [];
    const q = new ReviewQueue({ run: async (j) => { ran.push(`${j.repo}#${j.pr}`); } });
    q.enqueue({ owner: "o", repo: "r", pr: 1 });
    await q.drain();
    expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("queued");
    await q.drain();
    expect(ran.length).toBe(2);
  });

  test("never exceeds the concurrency cap", async () => {
    let active = 0, peak = 0;
    const q = new ReviewQueue({ concurrency: 2, run: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    }});
    for (let i = 0; i < 6; i++) q.enqueue({ owner: "o", repo: "r", pr: i });
    await q.drain();
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("a failing job does not kill the queue", async () => {
    const ran: number[] = [];
    const q = new ReviewQueue({ run: async (j) => { if (j.pr === 1) throw new Error("boom"); ran.push(j.pr); } });
    q.enqueue({ owner: "o", repo: "r", pr: 1 });
    q.enqueue({ owner: "o", repo: "r", pr: 2 });
    await q.drain();
    expect(ran).toEqual([2]);
  });
});
```

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd server && bun test test/queue.test.ts`
Expected: FAIL — `../src/queue` belum ada.

- [ ] **Step 3: Implementasi `queue.ts`**

In-flight `Set<string>` kunci `owner/repo#pr`; array antrian; `pump()` mengisi slot
sampai `concurrency`; `drain()` mengembalikan promise yang resolve saat antrian
kosong dan tidak ada job aktif. Error job → `log` + lanjut (jangan pernah reject).

- [ ] **Step 4: Wire ke server**

`http/server.ts` membuat satu `ReviewQueue` dengan `run: (j) => runReview(cfg, j.owner, j.repo, j.pr, privateKeyPem)`
lalu: sukses → `appendAnalyticsEvent` + Discord (logika lama dari `index.ts`),
gagal → Discord alert. `http/webhook.ts` hanya `queue.enqueue(job)` dan balas 200.

- [ ] **Step 5: Jalankan tes + typecheck + smoke manual**

Run: `cd server && bunx tsc --noEmit && bun test`
Lalu: `PORT=4099 bun src/main.ts &` → `curl -sS localhost:4099/health` → matikan.
Expected: tsc bersih, semua tes PASS, health `{"status":"ok","model":...}`.

- [ ] **Step 6: Commit**

```bash
git add -A server
git commit -m "feat(server): in-process review queue with dedupe and concurrency cap"
```

---

### Task 7: Server deploy + docs

**Files:**
- Modify: `.github/workflows/deploy.yml` (entry `src/main.ts`), `README.md`
- Delete: `templates/pr-agent-server.service` (unit Python yang sudah mati)
- Catatan: `scripts/README.md` **tidak** disentuh di sini — ditulis ulang di Task 17
  setelah worker TS ada (kalau ditulis sekarang akan mendeskripsikan worker Python).

**Interfaces:**
- Consumes: `startServer()` dari `server/src/http/server.ts` (Task 4).
- Produces: binary `/opt/pr-agent-server/bin/pr-agent-bun` (tidak berubah).

- [ ] **Step 1: Update deploy.yml**

`bun build --compile src/main.ts --outfile pr-agent-bun`; langkah typecheck+tests
tetap `bun install --frozen-lockfile && bunx tsc --noEmit && bun test`.

- [ ] **Step 2: Perbarui README.md**

Ganti seksi Architecture/Project Layout yang masih menyebut Python/uvicorn :4002
dengan layout dua paket (server + worker), sebut `bun` sebagai runtime, dan hapus
seksi "Legacy (Python/Nix)" setelah Task 17 (jangan hapus dulu — masih akurat sampai
cut-over).

- [ ] **Step 3: Hapus unit service Python yang sudah mati**

```bash
git rm templates/pr-agent-server.service
```

- [ ] **Step 4: Verifikasi build + smoke**

Run:
```bash
cd server && bun build --compile src/main.ts --outfile /tmp/pa-bun && \
  (PORT=4099 /tmp/pa-bun & sleep 2; curl -sS localhost:4099/health; curl -sS localhost:4099/api/metrics | head -3; kill %1)
```
Expected: health ok, metrics 200 dengan header Prometheus.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(server): deploy entry src/main.ts, refresh README, drop legacy unit template"
```

---

## FASE 2 — Worker TS (migrasi Python)

### Task 8: Kerangka worker + lock + state

**Files:**
- Create: `worker/package.json`, `worker/tsconfig.json`, `worker/src/env.ts`,
  `worker/src/lock.ts`, `worker/src/state.ts`, `worker/src/report.ts`
- Test: `worker/test/lock.test.ts`, `worker/test/state.test.ts`

**Interfaces:**
- Produces: `bootstrapEnv(): void` (PATH prepend + hydrate `PR_AGENT_*` dari `~/.hermes/.env`);
  `class WorkerLock { static acquire(path: string): WorkerLock | null; release(): void }`;
  `loadFixState(file: string): FixState`, `saveFixState(file: string, s: FixState): void`,
  `prEntry(state, repo, pr): PrEntry`, `alreadyFixed(state, repo, pr, sha): boolean`,
  `markFixed(...)`, `getSkipReason(...)`, `markSkip(...)`, `wasSkipNotified(...)`, `markSkipNotified(...)`;
  `loadSyncState(file: string): SyncState`, `saveSyncState(file: string, s: SyncState): void`;
  `class Report { push(line: string): void; flush(): Promise<void> }`.

- [ ] **Step 1: Buat `worker/package.json` + `tsconfig.json`**

```json
{
  "name": "pr-agent-worker",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "bun src/index.ts",
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit"
  },
  "devDependencies": { "@types/bun": "latest", "typescript": "^5.9.0" }
}
```

`tsconfig.json`: `strict: true`, `types: ["bun"]`, `module: ESNext`,
`moduleResolution: bundler`, `noEmit: true`, `include: ["src/**/*.ts", "test/**/*.ts"]`.

- [ ] **Step 2: Tulis tes GAGAL untuk lock + state toleran**

`worker/test/lock.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerLock } from "../src/lock";

describe("WorkerLock", () => {
  test("second acquire fails while the first holds it", () => {
    const p = join(mkdtempSync(join(tmpdir(), "wl-")), "l.lock");
    const a = WorkerLock.acquire(p);
    expect(a).not.toBeNull();
    expect(WorkerLock.acquire(p)).toBeNull();
    a!.release();
    expect(WorkerLock.acquire(p)).not.toBeNull();
  });

  test("recycles a stale lock whose PID is dead", () => {
    const p = join(mkdtempSync(join(tmpdir(), "wl-")), "l.lock");
    writeFileSync(p, "999999");
    const l = WorkerLock.acquire(p);
    expect(l).not.toBeNull();
    l!.release();
  });
});
```

`worker/test/state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixState, prEntry, alreadyFixed, markFixed, markSkip, getSkipReason, wasSkipNotified, markSkipNotified } from "../src/state";

describe("fix state", () => {
  test("missing file loads the empty shape", () => {
    expect(loadFixState(join(mkdtempSync(join(tmpdir(), "st-")), "none.json"))).toEqual({});
  });
  test("corrupt file loads the empty shape instead of throwing", () => {
    const f = join(mkdtempSync(join(tmpdir(), "st-")), "bad.json");
    writeFileSync(f, "{not json");
    expect(loadFixState(f)).toEqual({});
  });
  test("migrates the legacy bare-string entry", () => {
    const s: any = { "o/r": { "1": "abc123" } };
    prEntry(s, "o/r", 1);
    expect(s["o/r"]["1"].sha).toBe("abc123");
    expect(s["o/r"]["1"].notified).toBe(false);
  });
  test("skip reason is per head sha and notified once", () => {
    const s: any = {};
    markSkip(s, "o/r", 1, "sha1", "infra down");
    expect(getSkipReason(s, "o/r", 1, "sha1")).toBe("infra down");
    expect(getSkipReason(s, "o/r", 1, "sha2")).toBeFalsy();
    expect(wasSkipNotified(s, "o/r", 1, "sha1")).toBe(false);
    markSkipNotified(s, "o/r", 1, "sha1");
    expect(wasSkipNotified(s, "o/r", 1, "sha1")).toBe(true);
  });
  test("markFixed records the head sha", () => {
    const s: any = {};
    markFixed(s, "o/r", 1, "sha9");
    expect(alreadyFixed(s, "o/r", 1, "sha9")).toBe(true);
    expect(alreadyFixed(s, "o/r", 1, "other")).toBe(false);
  });
});
```

- [ ] **Step 3: Jalankan untuk memastikan GAGAL**

Run: `cd worker && bun test`
Expected: FAIL — `../src/lock` / `../src/state` belum ada.

- [ ] **Step 4: Implementasi `env.ts`, `lock.ts`, `state.ts`, `report.ts`**

- `env.ts`: `bootstrapEnv()` men-prepend `/home/code/.bun/bin`, `/home/code/.local/bin`,
  `/home/code/.hermes/bin`, `/usr/local/bin`, `/nix/var/nix/profiles/default/bin`;
  lalu hydrate `PR_AGENT_*` dari `$HERMES_HOME/.env` dan `~/.env` (env yang ada menang).
- `lock.ts`: `openSync(path, "wx")` + tulis PID; kalau EEXIST baca PID → `/proc/<pid>`
  ada? → null; kalau tidak → unlink lalu coba lagi sekali.
- `state.ts`: `readJsonTolerant(file, {})` (missing/corrupt → `{}`); semua helper
  memakai bentuk entry yang sama dengan Python (`{sha, skip_reason, notified}`,
  legacy string dimigrasi di tempat).
- `report.ts`: `push()` ke buffer; `flush()` → kalau `process.stdin.isTTY` print,
  kalau tidak POST ke `~/.hermes/.ops-webhooks.json["pr-agent-ops"]` embed
  `🔀 PR Queue Worker Report` (max 4000 char). Tidak pernah throw.

- [ ] **Step 5: Jalankan tes + typecheck**

Run: `cd worker && bunx tsc --noEmit && bun test`
Expected: PASS semua.

- [ ] **Step 6: Commit**

```bash
git add worker
git commit -m "feat(worker): scaffold TS worker with lock, state and report"
```

---

### Task 9: `github.ts` — ghApi + JWT RS256 + token cache

**Files:**
- Create: `worker/src/github.ts`
- Test: `worker/test/github.test.ts`

**Interfaces:**
- Produces: `class GitHubApi { constructor(opts: {appId: string; privateKeyPem: string; baseUrl?: string; retries?: number}); jwt(): string; request(method: string, path: string, opts?: {token?: string; json?: unknown; retries?: number}): Promise<{status: number; data: any}>; installationToken(installId: number): Promise<string>; fetchGhToken(): string (cached per process) }`

- [ ] **Step 1: Tulis tes GAGAL (JWT + retry/backoff + install token)**

`worker/test/github.test.ts`: bangun pasangan kunci RSA dengan `node:crypto`
(`generateKeyPairSync("rsa", {modulusLength: 2048})`), buat `GitHubApi`, lalu:
1. `jwt()` punya 3 segmen dan payload `iss === appId`, `exp - iat === 660`.
2. `request` mengirim header `Authorization: Bearer <jwt>` dan `Accept` GitHub,
   diverifikasi lewat `Bun.serve` fake server (`port: 0`) yang mencatat header.
3. Server fake membalas 500 dua kali lalu 200 → `request` tetap sukses dan
   tercatat 3 panggilan (backoff 1s, 2s di-mock dengan `retries: 2` + delay kecil:
   tes memakai `baseUrl` fake dan `retries: 2`, tunggu total ≤ 3s).
4. `fetchGhToken()` memanggil `gh auth token` sekali lalu cache (fake `gh` lewat
   `PATH` yang diarahkan ke script sementara — atau inject `spawn`).

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd worker && bun test test/github.test.ts`
Expected: FAIL — `../src/github` belum ada.

- [ ] **Step 3: Implementasi**

```ts
// RS256 tanpa dependency: header.payload + crypto.sign("sha256", data, key)
export function signJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({ iat: nowSec - 60, exp: nowSec + 600, iss: appId });
  const data = `${head}.${body}`;
  const sig = createSign("RSA-SHA256").update(data).sign(privateKeyPem).toString("base64url");
  return `${data}.${sig}`;
}
```

`request()` meniru Python `gh_api`: client `fetch` baru per attempt (DNS re-resolve),
retry 3× dengan backoff `2**attempt` detik untuk error transport (ConnectError,
RemoteProtocolError, timeout, ECONN*, EAI_AGAIN), balikan `{status: 0, data: {}}`
setelah habis (jangan throw — pemanggil memperlakukan 0 sebagai gagal).
`fetchGhToken()`: `Bun.spawnSync(["gh","auth","token"])` → trim; cache modul-level.

- [ ] **Step 4: Jalankan tes + typecheck**

Run: `cd worker && bunx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "feat(worker): github api client with RS256 jwt, retry and token cache"
```

---

### Task 10: `git.ts` — clone/merge/push + klasifikasi error push

**Files:**
- Create: `worker/src/git.ts`
- Test: `worker/test/git.test.ts`

**Interfaces:**
- Produces: `runGit(args: string[], cwd?: string, timeoutSec?: number): {code: number; stdout: string; stderr: string}`;
  `pushUrls(fork: string, appToken: string, pat: string): {url: string; kind: "pat" | "app"}[]`;
  `isProtectedPushError(err: string): boolean`; `isWorkflowPushError(err: string): boolean`;
  `pushRef(workdir: string, fork: string, source: string, dest: string, appToken: string, force?: boolean): {ok: boolean; detail: string; protected: boolean}`;
  `cloneForPr(repo: string, branch: string, token: string, workdir: string, depth?: number): boolean`;
  `setBotIdentity(workdir: string): void`.

- [ ] **Step 1: Tulis tes GAGAL untuk klasifikasi push**

`worker/test/git.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isProtectedPushError, isWorkflowPushError, pushUrls, runGit } from "../src/git";

describe("git helpers", () => {
  test("classifies protected-branch push errors", () => {
    expect(isProtectedPushError("remote: error: GH006: Protected branch update failed")).toBe(true);
    expect(isProtectedPushError("required status check \"ci\" is expected")).toBe(true);
    expect(isProtectedPushError("everything up-to-date")).toBe(false);
  });
  test("classifies workflow-permission push errors", () => {
    expect(isWorkflowPushError("refusing to allow an OAuth App to create or update workflow")).toBe(true);
    expect(isWorkflowPushError("permission denied")).toBe(false);
  });
  test("PAT is tried before the app token", () => {
    const urls = pushUrls("o/f", "apptok", "pattok");
    expect(urls.map((u) => u.kind)).toEqual(["pat", "app"]);
  });
  test("runGit returns code 124 on timeout and 127 when git is missing", () => {
    expect(runGit(["--version"], "/tmp", 5).code).toBe(0);
    const t = runGit(["fetch"], "/tmp", 0.001);
    expect([124, 128]).toContain(t.code); // timeout atau "not a git repository"
  });
});
```

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd worker && bun test test/git.test.ts`
Expected: FAIL — `../src/git` belum ada.

- [ ] **Step 3: Implementasi (port `_sync_git`, `_push_ref`, `_sync_push_urls`, clone identity)**

Marker list persis Python:
`_PROTECTED_PUSH_MARKERS = ["protected branch","gh006","required status check","branch protection","protected_branch"]`,
`_WORKFLOW_PUSH_MARKERS = ["workflows permission","workflows` permission","create or update workflow"]`
(dicek lowercase). `runGit` memakai `Bun.spawnSync` + `timeout` → exit 124; `git`
tidak ada → exit 127. `cloneForPr` mengeset `user.name=mytheclipsebotreview`,
`user.email=bot@users.noreply.github.com`, dan `--depth` default 20.

- [ ] **Step 4: Jalankan tes + typecheck**

Run: `cd worker && bunx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "feat(worker): git helpers with push-url strategy and error classification"
```

---

### Task 11: `agent.ts` — klien gateway Hermes + `discord.ts`

**Files:**
- Create: `worker/src/agent.ts`, `worker/src/discord.ts`
- Test: `worker/test/agent.test.ts` (port dari `scripts/test_pr_queue_sync.py::test_hermes_api_client` + `test_session_header_sent`)

**Interfaces:**
- Produces: `class AgentClient { constructor(opts: {baseUrl?: string; key?: string; timeoutSec?: number; maxTurns?: number}); post(prompt: string, opts?: {workdir?: string; sessionId?: string; label?: string; timeoutSec?: number}): Promise<{ok: boolean; snippet: string}> }`
- Produces: `postDiscordOps(title: string, lines: string[], color?: number): Promise<boolean>`;
  `notifyReview(repo: string, pr: number, status: string, summary: string, score: string, url: string): Promise<void>` (POST `http://127.0.0.1:4023/api/v1/notify_review`).

- [ ] **Step 1: Tulis tes GAGAL (kontrak HTTP persis seperti Python)**

`worker/test/agent.test.ts`: `Bun.serve({port: 0})` fake gateway yang menangkap
request, lalu assert:
1. Path `/v1/chat/completions`, header `Authorization: Bearer <key>`,
   `Content-Type: application/json`.
2. Body: `model === "hermes-agent"`, `provider === "custom:9router"`,
   `stream === false`, `model_options.max_turns === maxTurns`, dua message
   (system + user) dengan system memuat "Do NOT push".
3. `sessionId` → header `X-Hermes-Session-Id` terkirim; tanpa sessionId → header tidak ada.
4. HTTP 500 → `{ok:false, snippet: "[INFRA] ..."}`; tanpa `choices` → `[INFRA]`;
   connect error (port mati) → `[INFRA]`.
5. `ok:true` → snippet = konten pilihan pertama.
6. Prompt ditulis ke `<workdir>/<label>.prompt.txt` bila `workdir` + `label` diberikan.

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd worker && bun test test/agent.test.ts`
Expected: FAIL — `../src/agent` belum ada.

- [ ] **Step 3: Implementasi `agent.ts`**

System prompt persis Python:
`"You are an autonomous coding agent inside a git worktree. Use your terminal and file tools to complete the task. Work ONLY inside the current working directory. Do NOT push."`
Body + header persis Python. Error mapping: HTTP ≠ 200 → `[INFRA] Hermes API server HTTP <n>: <detail>`;
tanpa choices → `[INFRA] Hermes API server returned no choices: <msg>`;
timeout → `[INFRA] Hermes API server timed out after <t>s`;
connect → `[INFRA] Hermes API server unreachable at <base> (gateway up? API_SERVER_ENABLED?)`.
Key dibaca dari `API_SERVER_KEY` env → fallback `~/.hermes/.env` (fungsi `apiServerKey()`).
Untuk mode sync, prompt di-prepend `Your working directory is <workdir>. Start by running:\n  cd <workdir>\nThen complete the task below.` (persis `_run_hermes_sync`).

- [ ] **Step 4: Implementasi `discord.ts`**

`postDiscordOps` membaca `~/.hermes/.ops-webhooks.json["pr-agent-ops"]`; tidak pernah
throw; mengembalikan `status in (200, 204)`.
`notifyReview` POST ke `PR_AGENT_NOTIFY_URL` default `http://127.0.0.1:4023/api/v1/notify_review`
dengan body `{repo, pr, status, summary: summary.slice(0,500), score: String(score), url}`.

- [ ] **Step 5: Jalankan tes + typecheck**

Run: `cd worker && bunx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker
git commit -m "feat(worker): hermes gateway agent client and discord notifier"
```

---

### Task 12: `pr/` bagian 1 — scan, trigger review, safety, CI, pins

**Files:**
- Create: `worker/src/pr/scan.ts`, `worker/src/pr/review.ts`, `worker/src/pr/safety.ts`,
  `worker/src/pr/ci.ts`, `worker/src/pr/pins.ts`
- Test: `worker/test/pr-core.test.ts`

**Interfaces:**
- Produces: `gatherOpenPrs(api: GitHubApi): Promise<{token: string; repo: string; pr: any}[]>`;
  `findReviewComment(api, token, repo, pr): Promise<string | null>`;
  `findTrivialNoReviewMarker(api, token, repo, pr): Promise<boolean>`;
  `triggerReview(deps, repo, pr, title, headSha, headRef, baseRef): Promise<number | string>`;
  `analyzeReviewSafety(body: string): {safe: boolean; reasons: string[]; score: number}`;
  `checkCiPassed(api, token, repo, sha): Promise<{ok: boolean; msg: string}>`;
  `closeStaleCiPr(api, token, repo, pr, title, ciMsg): Promise<{status: number}>`;
  `toolchainPinViolation(repo, title): [string, string, string] | null`;
  `closeToolchainPr(api, token, repo, pr, pkg, oldVer, newVer): Promise<{status: number}>`.

- [ ] **Step 1: Tulis tes GAGAL (tabel safety + pin + CI)**

`worker/test/pr-core.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { analyzeReviewSafety } from "../src/pr/safety";
import { toolchainPinViolation } from "../src/pr/pins";
import { checkCiPassed } from "../src/pr/ci";

describe("safety", () => {
  const clean = "🔒 No security concerns identified\n⚡ No major issues detected\n🧪 No relevant tests\n⏱️ Estimated effort to review [1-5]: 1 🔵⚪⚪⚪⚪";
  test("clean review passes with score >= 6", () => {
    const r = analyzeReviewSafety(clean);
    expect(r.safe).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(6);
  });
  test("an error body blocks", () => {
    expect(analyzeReviewSafety("Failed to generate").safe).toBe(false);
    expect(analyzeReviewSafety("RetryError").safe).toBe(false);
    expect(analyzeReviewSafety("traceback").safe).toBe(false);
  });
  test("a security concern blocks", () => {
    expect(analyzeReviewSafety("🔒 Security concerns: SQL injection risk").safe).toBe(false);
  });
  test("a major issue blocks", () => {
    expect(analyzeReviewSafety("⚡ Breaking change detected").safe).toBe(false);
  });
  test("empty body blocks", () => {
    expect(analyzeReviewSafety("").safe).toBe(false);
  });
});

describe("toolchain pins", () => {
  test("flags a disallowed major on a pinned package", () => {
    expect(toolchainPinViolation("asepharyana/nextjs-template", "chore(deps): bump typescript from 5.9.0 to 7.0.0"))
      .toEqual(["typescript", "5.9.0", "7.0.0"]);
  });
  test("allows the pinned major", () => {
    expect(toolchainPinViolation("asepharyana/nextjs-template", "chore(deps-dev): bump typescript from 6.0.0 to 6.1.0")).toBeNull();
  });
  test("ignores repos without pins", () => {
    expect(toolchainPinViolation("o/r", "chore(deps): bump typescript from 5.0.0 to 7.0.0")).toBeNull();
  });
});

describe("ci gate", () => {
  const api = (data: unknown) => ({ request: async () => ({ status: 200, data }) }) as any;
  test("no checks configured passes", async () => {
    expect(await checkCiPassed(api({ check_runs: [] }), "t", "o/r", "sha")).toEqual({ ok: true, msg: "✅ No CI configured — skipping CI gate" });
  });
  test("failure blocks", async () => {
    const r = await checkCiPassed(api({ check_runs: [{ name: "ci", conclusion: "failure", status: "completed" }] }), "t", "o/r", "sha");
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("ci");
  });
  test("pending blocks", async () => {
    const r = await checkCiPassed(api({ check_runs: [{ name: "ci", conclusion: null, status: "in_progress" }] }), "t", "o/r", "sha");
    expect(r.ok).toBe(false);
  });
  test("all green passes", async () => {
    expect((await checkCiPassed(api({ check_runs: [{ name: "ci", conclusion: "success", status: "completed" }] }), "t", "o/r", "sha")).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd worker && bun test test/pr-core.test.ts`
Expected: FAIL — modul belum ada.

- [ ] **Step 3: Implementasi**

Port persis dari Python:
- `safety.ts` → `analyze_review_safety` (regex sama, skor sama, ambang `>= 6`).
- `ci.ts` → `check_ci_passed` + `close_stale_ci_pr` (`STALE_CI_CLOSE_DAYS = 2`,
  teks komentar sama).
- `pins.ts` → `TOOLCHAIN_PINS` map sama + `toolchain_pin_violation` + `close_toolchain_pr`.
- `review.ts` → `triggerReview` memakai payload webhook sintetis **lengkap**
  (`action`, `number`, `sender`, `installation.id`, `pull_request.url/state/draft/labels/head/base`,
  `repository.full_name`) + HMAC SHA-256 `sha256=<hex>` + header
  `x-github-event`, `x-hub-signature-256`, `x-github-delivery: cron-<ts>-<pr>`
  (tanpa ini server menolak diam-diam).
- `scan.ts` → `gatherOpenPrs`: `GET /app/installations` → per instalasi
  `GET /installation/repositories` → `GET /repos/{full}/pulls?state=open&per_page=20&sort=updated`.

- [ ] **Step 4: Jalankan tes + typecheck**

Run: `cd worker && bunx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "feat(worker): pr scan, review trigger, safety, ci and toolchain pins"
```

---

### Task 13: `pr/` bagian 2 — lockfix, autofix, merge

**Files:**
- Create: `worker/src/pr/lockfix.ts`, `worker/src/pr/autofix.ts`, `worker/src/pr/merge.ts`
- Test: `worker/test/pr-actions.test.ts`

**Interfaces:**
- Produces: `fixBunLock(deps, repo, pr, headRef, baseRef): Promise<{ok: boolean; summary: string}>`;
  `fixUvLock(deps, repo, pr, headRef, baseRef): Promise<{ok: boolean; summary: string}>`;
  `runAiFix(deps, repo, pr, title, headSha, headRef, baseRef, token): Promise<{ok: boolean; summary: string}>`;
  `approvePr(api, token, repo, pr): Promise<number>`;
  `mergePr(deps, api, token, repo, pr, sha): Promise<{status: number; data: any}>`;
  `isTrivialPr(title: string, author: string): boolean`.

- [ ] **Step 1: Tulis tes GAGAL untuk jalur skip lockfix + merge 403 PAT fallback**

`worker/test/pr-actions.test.ts`: inject deps (`runGit`, `agent`, `api`, `fetchGhToken`)
sehingga tidak menyentuh jaringan:
1. `fixBunLock` saat `bun install --frozen-lockfile` sukses → `{ok:false, summary:"bun.lock already consistent with package.json (CI failure elsewhere)"}` dan workdir dibersihkan.
2. `fixBunLock` saat frozen gagal + `bun install` mengubah `bun.lock` → commit
   `chore: sync bun.lock after dependabot bump` + push → `{ok:true}`.
3. `mergePr` 403 → retry dengan PAT (fake `fetchGhToken`), balikan hasil kedua.
4. `runAiFix`: agent `ok:false` dengan `[INFRA] ...` → `{ok:false}` dan summary
   berawalan `[INFRA]` (kontrak skip-once).
5. `runAiFix`: agent ok tapi `rev-list --count <sha>..HEAD` = 0 → `{ok:false}` +
   summary memuat "no commit/push".
6. `isTrivialPr("chore(deps): bump x", "dependabot[bot]")` → true;
   `isTrivialPr("feat: add login", "human")` → false.

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd worker && bun test test/pr-actions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi**

Port persis `fix_uv_lock_for_trivial_pr`, `fix_bun_lock_for_trivial_pr`, `run_ai_fix`,
`approve_pr`, `merge_pr`, `is_trivial_pr`, dengan **prompt AI fix identik** (termasuk
aturan "Do NOT push", merge base dulu, dan commit message `fix: auto-fix code quality [skip ci]`).
`runAiFix` menulis `hermes_pr_<n>.prompt.txt` di workdir, memakai
`agent.post(prompt, {workdir, timeoutSec: AI_FIX_TIMEOUT})`, lalu:
`rev-list --count <headSha[:12]>..HEAD` > 0 → worker yang push
(`git push origin HEAD:<headRef>`), gagal push → summary "AI committed but push failed: ...".

- [ ] **Step 4: Jalankan tes + typecheck**

Run: `cd worker && bunx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "feat(worker): lockfile fixes, ai autofix and merge actions"
```

---

### Task 14: `pr/pipeline.ts` + `index.ts` (entry + CLI flag)

**Files:**
- Create: `worker/src/pr/pipeline.ts`, `worker/src/index.ts`
- Test: `worker/test/pipeline.test.ts`

**Interfaces:**
- Produces: `runTick(deps: WorkerDeps): Promise<string[]>` (mengembalikan baris laporan);
  `processPr(deps, ctx): Promise<{merged: boolean; triggered: boolean; fixed: boolean; skipped: boolean}>`.
- CLI: `bun src/index.ts [--dry] [--sync-status] [--sync-only owner/fork [--dry]]`.

- [ ] **Step 1: Tulis tes GAGAL untuk keputusan per-PR**

`worker/test/pipeline.test.ts` dengan deps palsu:
1. PR tanpa review → `triggered` dan **berhenti** (tidak merge tick ini).
2. PR dengan review + safety bersih + CI hijau + mergeable → `merged` dan
   `approvePr` + `mergePr` dipanggil sekali.
3. PR dengan skip permanen di state pada SHA sama → `skipped`, agent **tidak** dipanggil.
4. `runAiFix` mengembalikan `[INFRA] ...` → `markSkip` tercatat + `notifyReview`
   (skip) terkirim sekali; tick berikutnya pada SHA sama tidak memanggil agent lagi.
5. PR dependabot yang melanggar pin → ditutup (`PATCH state=closed`), tidak ada
   review/agent/merge.
6. CI merah + dependabot + umur > 2 hari → ditutup; CI merah non-dependabot → `skipped`.
7. `mergeable === false` → agent dipanggil sekali untuk resolve; kalau gagal →
   skip permanen dengan alasan `Unresolvable merge conflict (Claude Code made no push)`.

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd worker && bun test test/pipeline.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `pipeline.ts`**

Pisahkan STEP A0–E dari `main()` Python menjadi fungsi bernama
(`stepPinGuard`, `stepReview`, `stepAiFix`, `stepSafety`, `stepCiGate`, `stepMerge`),
dengan urutan & pesan laporan sama. `processPr` memanggilnya berurutan dan
mengembalikan hasil. `runTick`:
`bootstrapEnv()` → `WorkerLock.acquire("/tmp/pr-queue-worker.lock")` (null → keluar diam) →
`runUpstreamSync()` (Task 15) → `gatherOpenPrs()` → loop `processPr` → ringkasan
(`📊 Summary (<n>s)`, `✨ AI fixes applied`, `✅ Merged`, `📡 Reviews triggered`, `⏭️ Skipped`) →
`report.flush()` → `lock.release()` (juga pada SIGTERM).

- [ ] **Step 4: Implementasi `index.ts` + flag CLI**

`--sync-status` → print `JSON.stringify(loadSyncState(), null, 2)`;
`--sync-only <repo> [--dry]` → ambil lock, `runUpstreamSync({only, dry})`, print laporan;
default → `runTick()`. `--dry` = tidak menulis state, tidak push, tidak buka PR,
tidak kirim Discord (dipaksa lewat flag `dry` di deps).

- [ ] **Step 5: Jalankan tes + typecheck + dry-run nyata**

Run:
```bash
cd worker && bunx tsc --noEmit && bun test
bun src/index.ts --sync-status
bun src/index.ts --sync-only asepharyana/shiro-neko --dry   # harus "would …" tanpa efek samping
```
Expected: tes PASS; `--sync-status` mencetak JSON; dry-run tidak mengubah
`/tmp/pr-queue-sync-state.json` (bandingkan `sha256sum` sebelum/sesudah).

- [ ] **Step 6: Commit**

```bash
git add worker
git commit -m "feat(worker): per-pr pipeline, tick runner and CLI flags"
```

---

### Task 15: `sync/` — port penuh upstream fork sync (termasuk salvage & revert)

**Files:**
- Create: `worker/src/sync/config.ts`, `worker/src/sync/repos.ts`,
  `worker/src/sync/merge.ts`, `worker/src/sync/verify.ts`, `worker/src/sync/run.ts`
- Test: `worker/test/sync.test.ts` (port seluruh assertion `scripts/test_pr_queue_sync.py`)

**Interfaces:**
- Produces: `syncConfig(repo): SyncConfig`; `listForkRepos(api): Promise<[string, string, string, string][]>`;
  `upstreamStatus(api, token, fork, parent, localBranch, upstreamBranch): Promise<[number, number, string] | null>`;
  `syncForkRepo(deps, ...): Promise<[SyncStatus, string]>` dengan
  `SyncStatus = "synced" | "pr-opened" | "conflict-failed" | "push-failed" | "error" | "dry" | "pr-path"`;
  `verifyPendingSyncs(state, tokenByRepo, dry): Promise<string[]>`;
  `runUpstreamSync(opts?: {only?: string; dry?: boolean}): Promise<string[]>`.

- [ ] **Step 1: Tulis tes GAGAL — port 51 assertion**

Port `scripts/test_pr_queue_sync.py` ke `worker/test/sync.test.ts` dengan deps palsu
(git, ghApi, agent, push) — assertion yang wajib ada:
1. `upstreamStatus` parsing `ahead_by`/`behind_by` + tip (termasuk fallback tip dari
   `GET /repos/{parent}/commits/{branch}`).
2. Gating: interval belum lewat → tidak ada percobaan; SHA upstream sama → skip;
   `last_sync_ts` di-backdate → tip baru diproses.
3. Clean merge → `synced` + `pending_verify` terisi + push dipanggil sekali.
4. **Dry run murni**: `state == {}` setelah `syncForkRepo(dry)` (tidak ada tulisan).
5. Conflict → agent dipanggil → `_sync_finish_merge` sukses → `synced`.
6. Conflict gagal → `conflict-failed` + `skip_reason` + `last_attempt_sha` + `notified:false`.
7. **Salvage**: agent `ok:false` TAPI daftar file unmerged sudah kosong saat itu →
   `synced` (bukan abort).
8. Protected push → `pr-opened` + `POST /pulls` dengan head `upstream-sync-*`.
9. `verifyPendingSyncs`: hijau → `pending_verify` dikosongkan; merah → `_sync_revert_merge`
   dipanggil; commit asing di atas merge kita → tidak revert; CI masih running → tunggu;
   tanpa check-runs dan umur < `no_ci_grace_s` → tunggu; umur > 6 jam → berhenti menonton.
10. `listForkRepos` hanya repo `fork: true` dengan `parent.full_name`.
11. Klasifikasi error push (protected/workflow).
12. Override `syncConfig` per repo (`interval_h`, `verify_ci`, `branches`).
13. `_sync_finish_merge` menolak commit kalau masih ada marker konflik
    (`<<<<<<<`, `=======`, `>>>>>>>`).

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd worker && bun test test/sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi (port `sync_fork_repo`, `verify_pending_syncs`, `run_upstream_sync`)**

Pertahankan persis: urutan clone → identity → `pre_merge_sha` → fetch upstream
`--no-tags <url> <branch>:refs/remotes/upstream/<branch>` → merge → deteksi unmerged →
resolve via agent (`sessionId: "sync_<fork with _>"`, prompt di-prepend `cd <workdir>`)
→ salvage (`syncFinishMerge` saat agent gagal) → quality pass bila merge bersih →
`pushRef` → protected → `openSyncPr` → state update → cleanup workdir di `finally`.
Budget per tick `max_per_tick = 2`, sortir fork paling lama tidak disinkron dulu.

- [ ] **Step 4: Jalankan tes + typecheck**

Run: `cd worker && bunx tsc --noEmit && bun test`
Expected: PASS — semua assertion port lulus.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "feat(worker): upstream fork sync with salvage, protected-pr path and ci revert"
```

---

### Task 16: `ops/syncHooks.ts` — migrasi `pr-ops-notifier.py`

**Files:**
- Create: `worker/src/ops/syncHooks.ts`, `worker/src/ops/templates/*.yml`
  (salin dari `~/.hermes/scripts/templates/`: `dependabot.yml`, `dependabot-gmw.yml`,
  `dependabot-auto-merge.yml` — isi tidak berubah)
- Test: `worker/test/ops.test.ts`

**Interfaces:**
- Produces: `runSyncHooks(deps?: {ghToken?: string; webhookSecret?: string; repos?: string[]; fetch?: typeof fetch}): Promise<{ok: number; skip: number; lines: string[]}>`.

- [ ] **Step 1: Tulis tes GAGAL**

`worker/test/ops.test.ts`: fake `fetch` mencatat request; assert:
1. Repo tanpa webhook pr-agent → `POST /repos/{repo}/hooks` dengan
   `config.url = https://pr-agent.asepharyana.my.id/api/v1/github_webhooks`,
   `content_type: json`, `secret = <webhookSecret>`, dan
   `events = ["issue_comment","pull_request","pull_request_review","pull_request_review_comment"]`.
2. Repo yang sudah punya webhook pr-agent → tidak ada POST hooks (skip).
3. `asepharyana/GMW` memakai template `dependabot-gmw.yml`; repo lain `dependabot.yml`;
   file `.github/dependabot-auto-merge.yml` dipasang dari template ke-3.
4. Tanpa `webhookSecret` → langkah webhook dilewati sepenuhnya.
5. Ringkasan `{ok, skip, lines}` cocok dengan jumlah aksi sukses/skip.

- [ ] **Step 2: Jalankan untuk memastikan GAGAL**

Run: `cd worker && bun test test/ops.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi (port `pr-ops-notifier.py`)**

Logika sama: ambil token `gh auth token`; list repo `GET /users/asepharyana/repos?per_page=100`;
per repo pastikan hook + file dependabot (baca isi sekarang lewat
`GET /repos/{repo}/contents/{path}`; kalau beda → `PUT` dengan sha); kirim ringkasan
lewat `webhook-post` → ganti dengan `postDiscordOps` (Task 11) agar tidak ada Python.
Rahasia webhook dari env `GITHUB_WEBHOOK_SECRET` (bukan `sudo bws-exec` — jalankan
dengan `bws-exec pr-agent` di wrapper supaya secret tersedia).

- [ ] **Step 4: Jalankan tes + typecheck**

Run: `cd worker && bunx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "feat(worker): migrate pr-ops-notifier to ops/syncHooks (ts)"
```

---

## FASE 3 — Cut-over + hapus Python

### Task 17: Wrapper cron, migrasi cron job, hapus Python, docs

**Files:**
- Modify: `~/.hermes/scripts/pr-queue-worker.sh` (wrapper bun),
  `~/.hermes/cron/jobs.json` (job `d98760ebee2c` → `pr-ops-notifier.sh`),
  `README.md`, `scripts/README.md`, `.github/workflows/deploy.yml` (typecheck+test worker)
- Create: `scripts/pr-ops-notifier.sh`
- Delete: `scripts/pr-queue-worker.py`, `scripts/test_pr_queue_sync.py`,
  `scripts/smoke_hermes_api_server.py`, `~/.hermes/scripts/pr-ai-fixer.py`,
  `~/.hermes/scripts/pr-ops-notifier.py`, `~/.hermes/scripts/pr-queue-worker.py`

- [ ] **Step 1: Wrapper worker baru (simpan yang lama)**

```bash
cp ~/.hermes/scripts/pr-queue-worker.sh ~/.hermes/scripts/pr-queue-worker.sh.prev
```
Isi baru:
```bash
#!/usr/bin/env bash
set -uo pipefail
export PATH="/home/code/.bun/bin:/home/code/.local/bin:/home/code/.hermes/bin:/usr/local/bin:/nix/var/nix/profiles/default/bin:$PATH"
REPO="/home/code/pr-agent-server"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch origin main --quiet 2>/dev/null
  git -C "$REPO" merge --ff-only origin/main --quiet 2>/dev/null \
    || echo "[pr-queue-worker] sync warn: ff-only pull failed — running existing repo copy" >&2
fi
[ -f "$REPO/worker/src/index.ts" ] || { echo "[pr-queue-worker] ERROR: worker missing" >&2; exit 1; }
exec "$(command -v bun)" "$REPO/worker/src/index.ts" "$@"
```

- [ ] **Step 2: Verifikasi wrapper dengan PATH cron minimal**

Run: `env -i HOME=/home/code bash ~/.hermes/scripts/pr-queue-worker.sh --sync-status`
Expected: JSON state tercetak, exit 0 (tanpa error `bun: not found`).

- [ ] **Step 3: Bandingkan dry-run TS vs Python pada tick yang sama**

```bash
cd /home/code/pr-agent-server
/home/code/hermes-agent/.venv/bin/python3 scripts/pr-queue-worker.py --sync-only asepharyana/shiro-neko --dry > /tmp/py-dry.txt 2>&1
bun worker/src/index.ts --sync-only asepharyana/shiro-neko --dry > /tmp/ts-dry.txt 2>&1
diff <(grep -o 'fork.*' /tmp/py-dry.txt | head) <(grep -o 'fork.*' /tmp/ts-dry.txt | head) || true
cat /tmp/ts-dry.txt
```
Expected: keputusan sama (fork/PR yang sama, "would …"/"prepared"), dan
`/tmp/pr-queue-sync-state.json` tidak berubah (`sha256sum` sama).

- [ ] **Step 4: Migrasi cron job harian**

Buat `~/.hermes/scripts/pr-ops-notifier.sh`:
```bash
#!/usr/bin/env bash
set -uo pipefail
export PATH="/home/code/.bun/bin:$PATH"
exec /usr/local/bin/bws-exec pr-agent bun /home/code/pr-agent-server/worker/src/ops/syncHooks.ts
```
Ubah job `d98760ebee2c` (`script: "pr-ops-notifier.sh"`), lalu jalankan manual sekali:
`bash ~/.hermes/scripts/pr-ops-notifier.sh` → harus menghasilkan ringkasan tanpa error.

- [ ] **Step 5: Hapus Python + update CI + docs**

```bash
cd /home/code/pr-agent-server
git rm scripts/pr-queue-worker.py scripts/test_pr_queue_sync.py scripts/smoke_hermes_api_server.py
rm -f ~/.hermes/scripts/pr-ai-fixer.py ~/.hermes/scripts/pr-ops-notifier.py ~/.hermes/scripts/pr-queue-worker.py
rm -rf ~/.hermes/scripts/__pycache__
```
`deploy.yml`: tambah langkah `cd worker && bun install && bunx tsc --noEmit && bun test`
sebelum build. `README.md`: layout dua paket, hapus seksi "Legacy (Python/Nix)".
`scripts/README.md`: tulis ulang (worker TS, tidak ada `cp` manual, cara menjalankan
`--sync-status`/`--sync-only`/`--dry`).

- [ ] **Step 6: Verifikasi akhir (satu siklus penuh)**

```bash
# tidak ada proses/skrip python yang tersisa
pgrep -af "pr-queue-worker.py|pr-ops-notifier.py|pr-ai-fixer.py" || echo "clean"
ls /home/code/pr-agent-server/scripts/
# tick nyata (bukan dry) → harus menghasilkan laporan tanpa error
env -i HOME=/home/code PATH=/usr/bin:/bin bash ~/.hermes/scripts/pr-queue-worker.sh
```
Expected: tidak ada proses Python; `scripts/` hanya `.sh` + `README.md`; tick berjalan
dan melaporkan PR/ringkasan; log tidak memuat traceback.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: cut over to bun worker, migrate cron, remove python implementation"
```

---

## Verifikasi Penutup (setelah semua task)

- [ ] `cd server && bunx tsc --noEmit && bun test` → bersih + semua lulus.
- [ ] `cd worker && bunx tsc --noEmit && bun test` → bersih + semua lulus.
- [ ] `grep -rn "\.py\b" server/src worker/src` → tidak ada.
- [ ] `git ls-files '*.py'` → kosong.
- [ ] `bun build --compile server/src/main.ts` sukses; `/health` + `/api/metrics` 200.
- [ ] Webhook ping → `{ok:true,ignored:true}`; webhook PR uji → review terpublish.
- [ ] Tick cron worker nyata → laporan tanpa traceback; tidak ada proses Python.
- [ ] `sha256sum /tmp/pr-queue-*.json` sama sebelum/sesudah `--dry` (dry murni).

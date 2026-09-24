# Spec: Rombak Arsitektur pr-agent-server (server + worker → TS/Bun)

Status: DRAFT — menunggu review user sebelum implementasi.

## 1. Tujuan

Satu repo, satu bahasa (TypeScript/Bun), satu build (`bun build --compile`),
untuk seluruh lifecycle PR otomatis:

- **server** — webhook GitHub App → review / describe / improve + analytics + Discord
- **worker** — cron 5 menit: scan PR → trigger review → AI fix → safety → CI → merge,
  plus upstream fork auto-sync

Keberhasilan:
1. `pr-queue-worker.py` (2224 baris Python) hilang; worker jadi `worker/` (TS/Bun),
   dijalankan cron dengan `bun`.
2. Tidak ada file > 400 baris yang berisi logika campur (data/prompt dikecualikan).
3. Tidak ada kode mati, tidak ada duplikasi helper antar modul.
4. Perilaku produksi identik atau lebih baik; semua invariant §5 punya tes.
5. Deploy tetap lewat GHA push-to-main (binary di-swap, service restart).

Non-goal: fitur baru untuk pengguna. Fitur baru hanya yang lahir dari pemisahan
modul yang benar (queue dedupe, retry LLM, per-tool model).

## 2. Masalah yang dirombak (temuan audit)

### Server (Bun, 2.9k LOC)
| # | Masalah | Bukti |
|---|---------|-------|
| S1 | `index.ts` 482 baris monolith: HTTP + webhook + Discord + analytics + metrics + setup callback | `src/index.ts` |
| S2 | `diff.ts` 711 baris: hunk regex + context extension + token budget + multi-chunk + sorting | `src/diff.ts` |
| S3 | Analytics ditulis `appendFileSync` di dalam handler webhook (blocking event loop) | `index.ts:95`, `index.ts:436` |
| S4 | `readPrivateKey`/`readAnalyticsLogs` pakai `require("node:fs")` di ESM | `index.ts:344,366` |
| S5 | Webhook fire-and-forget tanpa antrian/dedupe → burst event = review ganda; tidak ada retry | `index.ts:78` |
| S6 | Duplikasi: `clipTokensSimple` (review) vs `clipTokens` (diff); `getModelTokenLimitLocal` (diff) vs `getModelTokenLimit` (config); `secrets.ts` vs `config.ts` sama-sama baca key file | `review.ts:207`, `diff.ts:560`, `config.ts:97`, `secrets.ts:34` |
| S7 | Kode mati: `renderTemplateTolerant`, `decodeIfBytes`, `awaitLocalFs`, `getHttpx`, `_discordClient`, `ensureInstallationToken` (7 call site, bisa jadi 1 pre-fetch) | grep |
| S8 | Bug: `getPrDiffWithFiles` baca `vars["_langs"]` yang tidak pernah di-set → sorting bahasa tidak pernah jalan | `review.ts:200` |
| S9 | Bug: `publishPersistentComment` `c.body ? content.replace(...) : content` — kondisi terbalik/tak bermakna | `github.ts:411` |
| S10 | Bug: `installTokenStrategy` hook mengirim request tanpa header auth saat token belum ada (async race → 401) | `github.ts:95` |
| S11 | Fallback model hanya iterasi list; tidak ada retry per-model untuk error transient | `review.ts:117` |
| S12 | README mendeskripsikan arsitektur Python/uvicorn :4002 yang sudah retired (kontradiksi dengan seksi Legacy di file yang sama) | `README.md` |
| S13 | `templates/pr-agent-server.service` masih unit Python/Nix (matang) | `templates/` |

### Worker (Python 2224 LOC)
| # | Masalah | Bukti |
|---|---------|-------|
| W1 | `main()` 392 baris prosedural, 5 STEP bercampur di satu loop | `pr-queue-worker.py:1833-2224` |
| W2 | Satu file memuat: HTTP client, state, lock, git, Discord, review detect, safety, CI, pins, lockfix, autofix, merge, upstream sync (~40 fungsi, 10 domain) | seluruh file |
| W3 | Duplikasi `_fetch_gh_token` (didefinisikan 2×), pola `workdir cleanup` 12×, pola clone+identity 4× | grep |
| W4 | Bahasa campur: server Bun + worker Python = 2 toolchain, 2 cara state, 2 test runner | repo |
| W5 | README `scripts/README.md` menginstruksikan `cp` manual ke `~/.hermes/scripts/` padahal wrapper sudah ff-only pull | `scripts/README.md` |

## 3. Arsitektur target

```
pr-agent-server/
├── server/                     # webhook server (binary produksi, :4023)
│   ├── src/
│   │   ├── index.ts            # entry: import.meta.main → http/server.ts
│   │   ├── config.ts           # SATU sumber config + secrets (key file, env)
│   │   ├── core/
│   │   │   ├── token.ts        # tiktoken + countPromptTokens
│   │   │   ├── render.ts       # nunjucks strict
│   │   │   ├── yaml.ts         # loadYaml + tryFixYaml (fallback chain)
│   │   │   └── markdown.ts     # convertToMarkdownV2
│   │   ├── github/
│   │   │   ├── client.ts       # App JWT → installation token (pre-fetch, no race)
│   │   │   └── provider.ts     # PR data, diffs, comments, labels, line links
│   │   ├── diff/
│   │   │   ├── hunk.ts         # parseHunkHeader, omitDeletionHunks, convert-to-line-numbers
│   │   │   ├── extend.ts       # extendPatch (context + dynamic context)
│   │   │   ├── filter.ts       # generated/invalid/bad-extension filter
│   │   │   ├── budget.ts       # generateFullPatch + getPrDiff (token budget)
│   │   │   └── multi.ts        # getPrMultiDiffs (chunking untuk improve)
│   │   ├── http/
│   │   │   ├── server.ts       # Bun.serve + route table
│   │   │   ├── webhook.ts      # HMAC verify + parse → queue.enqueue
│   │   │   ├── notify.ts       # POST /api/v1/notify_review
│   │   │   ├── analytics.ts    # GET /api/metrics, /api/analytics
│   │   │   └── setup.ts        # GET /setup/callback
│   │   ├── queue.ts            # antrian review: dedupe + concurrency + retry
│   │   ├── analytics.ts        # readAnalyticsLogs + logReviewEvent (async append)
│   │   ├── notify/discord.ts   # sendDiscord + htmlToDiscordPlain
│   │   ├── llm.ts              # chatCompletion + callWithFallback (retry/backoff)
│   │   ├── tools/
│   │   │   ├── review.ts       # runReview
│   │   │   ├── describe.ts     # runDescribe + helpers diagram/walkthrough
│   │   │   ├── improve.ts      # runImprove + render tabel saran
│   │   │   └── publish.ts      # publishPersistent (dipakai review/describe/improve)
│   │   └── prompts/
│   │       ├── review.ts, describe.ts, suggestions.ts   # data prompt
│   ├── test/                   # bun:test (port + tes baru)
│   └── e2e.ts
├── worker/                     # cron worker (TS/Bun)
│   ├── src/
│   │   ├── index.ts            # entry + CLI flag (--sync-status/--sync-only/--dry)
│   │   ├── env.ts              # PATH bootstrap + .env hydration + config
│   │   ├── lock.ts             # atomic lockfile (stale-PID recycle)
│   │   ├── state.ts            # fix-state & sync-state (load toleran, save)
│   │   ├── github.ts           # ghApi (JWT + installation token) + retry/backoff
│   │   ├── git.ts              # clone/merge/push, push-url strategy, identity
│   │   ├── agent.ts            # Hermes gateway client (/v1/chat/completions)
│   │   ├── discord.ts          # report + ops webhook
│   │   ├── report.ts           # buffer + flush_log
│   │   ├── pr/
│   │   │   ├── scan.ts         # gatherOpenPrs
│   │   │   ├── review.ts       # findReviewComment + triggerReview (webhook sintetis)
│   │   │   ├── safety.ts       # analyzeReviewSafety
│   │   │   ├── ci.ts           # checkCiPassed + closeStaleCiPr
│   │   │   ├── pins.ts         # TOOLCHAIN_PINS + closeToolchainPr
│   │   │   ├── lockfix.ts      # bun.lock / uv.lock fix
│   │   │   ├── autofix.ts      # runAiFix (agent + push)
│   │   │   ├── merge.ts        # approve + merge (+ PAT fallback) + notify
│   │   │   └── pipeline.ts     # STEP A0→E per PR (fungsi per step)
│   │   └── sync/
│   │       ├── config.ts       # UPSTREAM_SYNC + per-repo override
│   │       ├── repos.ts        # listForkRepos + upstreamStatus
│   │       ├── merge.ts        # syncForkRepo (+ salvage, protected→PR)
│   │       ├── verify.ts       # verifyPendingSyncs (CI revert)
│   │       └── run.ts          # runUpstreamSync (gating per interval/budget)
│   └── test/                   # bun:test (port 51 assertion)
├── scripts/
│   ├── pr-queue-worker.sh      # wrapper cron (ff-only pull → bun worker)
│   └── README.md               # diperbarui: tidak ada cp manual
└── .github/workflows/deploy.yml # typecheck+test server & worker → build 2 binary
```

Aturan ukuran: file logika ≤ 400 baris; file prompt/data bebas. Tidak ada
direktori yang dibuat untuk satu implementasi (tidak ada interface/abstraksi
spekulatif).

## 4. Perubahan perilaku yang disengaja

| # | Perubahan | Alasan |
|---|-----------|--------|
| B1 | Webhook masuk **antrian in-process** (bukan fire-and-forget): dedupe `repo#pr`, concurrency 2, retry 3× backoff untuk error transient | S5: burst event / worker fabricate tiap 5 menit memicu review ganda |
| B2 | Job review baca head SHA PR; kalau SHA itu sudah direview (tercatat di memory queue) → skip + log | dedupe sebenarnya, bukan sekadar TTL |
| B3 | Analytics ditulis async (append serialized) | S3: jangan block event loop |
| B4 | `chatCompletion` dibungkus `callWithFallback`: per model, retry 2× untuk error transient (network/5xx/timeout), bukan untuk 4xx | S11 |
| B5 | Model per tool: `PR_AGENT_MODEL_REVIEW` / `_DESCRIBE` / `_IMPROVE`, fallback ke `PR_AGENT_MODEL` | permintaan user |
| B6 | `getPrDiff` memakai bahasa PR untuk sorting (bug S8 diperbaiki) | sorting yang selama ini mati |
| B7 | `publishPersistentComment` pakai header match yang benar | S9 |
| B8 | Installation token di-prefetch sebelum request pertama; hook tidak lagi mengirim tanpa auth | S10 |
| B9 | Worker: `_fetch_gh_token` di-cache per tick; helper clone/workdir jadi satu fungsi | W3 |
| B10 | Semua invariant perilaku worker dipertahankan: gating interval sync, skip-once dedupe, salvage timeout, revert CI merah, protected→PR, `[INFRA]` prefix | jangan rusak produksi |

## 5. Invariant yang harus tetap benar (dites)

Server:
1. HMAC `x-hub-signature-256` tidak valid → 403; signature hilang → 403.
2. Event bukan `pull_request` → 200 `{ignored:true}`; PR draft/closed → 200 ignored.
3. Webhook balas < 1s (kerja review tidak menahan response).
4. Format event analytics sama (JSONL legacy shape) — dashboard lama tetap baca.
5. `/api/metrics` & `/api/analytics` menghasilkan angka sama untuk input log yang sama.
6. Comment review persisten: update comment lama (header `## PR Reviewer Guide 🔍`), bukan spam baru.
7. `getModelTokenLimit` sama persis untuk tabel model yang ada.
8. `loadYaml` fallback chain tidak berubah hasilnya untuk fixture yang ada.
9. Prompt review/describe/improve yang dirender untuk variabel sama = byte-identik dengan versi sekarang (regression test: render snapshot sebelum vs sesudah).

Worker:
10. Lock: dua tick bersamaan → hanya satu jalan; lock stale (PID mati) di-recycle.
11. State file hilang/rusak → load toleran (shape kosong), tidak crash.
12. Skip permanen per (repo, pr, SHA) + notifikasi Discord sekali per (repo, pr, SHA, reason).
13. Review error terdeteksi (`Failed to generate`, `Error during`, `traceback`) → blokir.
14. Score safety ≥ 6 baru boleh merge; security concern / major issue → blokir.
15. CI gate: failed/pending → tidak merge; PR dependabot CI merah > 2 hari → ditutup.
16. `[INFRA]` prefix → skip sekali, tidak loop tiap 5 menit.
17. Sync: interval 1 jam per fork, `last_attempt_sha` sama → skip, max 2 fork per tick.
18. Sync conflicted → agent resolve → salvage kalau agent timeout tapi merge sudah selesai; marker konflik tersisa → jangan commit.
19. Sync push protected → buka PR `upstream-sync-*`; CI merah di merge commit sendiri → revert (hanya kalau masih tip).
20. `--dry` tidak menulis state, tidak push, tidak buka PR, tidak kirim Discord.

## 6. Strategi cut-over (aman, bisa rollback)

1. Bangun `worker/` + tes; jalankan `worker` dengan `--dry` di host, bandingkan
   laporan dengan Python pada tick yang sama (repo/PR yang sama, keputusan sama).
2. Ganti isi `~/.hermes/scripts/pr-queue-worker.sh`: `bun worker/src/index.ts`
   (binary lebih baik: `worker/dist/pr-agent-worker`). Simpan wrapper lama sebagai
   `.prev` → rollback = tukar file + tidak ada perubahan state.
3. Server: `deploy.yml` build dua binary (`pr-agent-bun`, `pr-agent-worker`);
   worker binary di `/opt/pr-agent-server/bin/`, dijalankan dari repo (cron
   wrapper) atau systemd timer — diputuskan saat implementasi (pilihan: wrapper
   cron tetap, binary dari repo, karena cron sudah ff-only pull).
4. Setelah worker TS stabil ≥ 24 jam: hapus `scripts/pr-queue-worker.py`,
   `scripts/test_pr_queue_sync.py`, `scripts/smoke_hermes_api_server.py`.

State file di `/tmp` **tidak berubah format** (dibaca dua implementasi selama
transisi) → cut-over tidak kehilangan riwayat skip/fix.

## 7. Verifikasi (bukti minimum)

1. `bunx tsc --noEmit` bersih untuk `server/` dan `worker/`.
2. `bun test` server: 16 tes lama tetap lulus + tes baru (queue dedupe, retry,
   HMAC, analytics shape, persistent comment, model limit).
3. `bun test` worker: port 51 assertion `test_pr_queue_sync.py` lulus
   (monkeypatch/fake ghApi, git, agent, push) + tes lock/state/safety/CI gate.
4. Regression prompt: snapshot render prompt sebelum rombak == sesudah.
5. Dry-run worker vs Python di host yang sama: laporan sama untuk tick yang sama.
6. Smoke server: `curl /health`, webhook ping `{ok:true,ignored:true}`, webhook
   PR palsu → review dipublish (pakai PR uji), `/api/metrics` & `/api/analytics` 200.
7. GHA: typecheck + test dua paket hijau; deploy binary + health check 4023.

## 8. Risiko

| Risiko | Mitigasi |
|--------|----------|
| Porting 2.2k LOC worker ke TS menghilangkan perilaku halus | Port test dulu (51 assertion) sebagai kontrak; jalankan `--dry` paralel sebelum flip |
| Worker TS bug di jalur yang jarang (protected push, revert CI) | Tes dengan fake git/gh untuk tiap status (`synced`, `pr-opened`, `conflict-failed`, `push-failed`, `dry`) |
| Cron 5 menit vs build binary | Wrapper cron menjalankan `bun` dari repo (sudah ff-only pull); binary hanya untuk server |
| State `/tmp` tidak kompatibel | Format JSON dipertahankan byte-for-byte |
| Waktu implementasi besar (2 paket + tes) | Fase terpisah: server dulu (bisa deploy sendiri), worker kedua |

## 9. Migrasi penuh Python → TS (permintaan user: "bagaimanapun caranya")

### 9.1 Artefak Python yang dimigrasi

| Artefak | LOC | Nasib |
|---------|-----|-------|
| `scripts/pr-queue-worker.py` | 2224 | → `worker/src/**` (TS/Bun). Dihapus setelah cut-over |
| `scripts/test_pr_queue_sync.py` | 697 | → `worker/test/**` (bun:test), 51 assertion dipertahankan |
| `scripts/smoke_hermes_api_server.py` | 98 | diganti `worker/src/agent.ts` + tes fake-server (kontrak HTTP yang sama) |
| `~/.hermes/scripts/pr-ai-fixer.py` | 109 | **dihapus** — duplikat legacy dari `run_ai_fix` di worker (tidak ada cron yang menjalankannya) |
| `~/.hermes/scripts/pr-ops-notifier.py` | 109 | → `worker/src/ops/syncHooks.ts` (job cron harian). Python dihapus |

Tidak dimigrasi (di luar repo ini, dipakai cron lain): `~/.hermes/scripts/webhook-post.py`
(4 cron non-PR memakainya), `gmw-video-watch.py`, `terabox-resolver-watch.py`,
`gitea-sync-all.sh`, `9router-update-cron.sh`.

### 9.2 Cron yang disesuaikan

| Cron (id) | Sebelum | Sesudah |
|-----------|---------|---------|
| `pr-queue-worker` (`04f13b9fdadc`) | `pr-queue-worker.sh` → `python3 repo/scripts/pr-queue-worker.py` | `pr-queue-worker.sh` → `bun repo/worker/src/index.ts` (wrapper ff-only pull tetap) |
| `pr-agent-health-watchdog` (`629522b9c2f8`) | `pr-agent-health-check.sh` (bash+curl) | **tidak berubah** (bukan Python; hanya curl + webhook-post) |
| `sync-pr-agent-hooks-daily` (`d98760ebee2c`) | `pr-ops-notifier.py` (Python) | `pr-ops-notifier.sh` → `bun repo/worker/src/ops/syncHooks.ts` |

Wrapper cron memakai `bun` langsung (bukan binary) supaya setiap tick menjalankan
kode terbaru dari repo — wrapper sudah ff-only pull. Konsekuensi: `bun` harus ada di
PATH cron (sudah ada: `/home/code/.bun/bin`, dipakai cron lain? belum — wrapper
menambahkannya sendiri).

### 9.3 Deploy + bootstrap worker (problem build-di-CI)

`deploy.yml` berjalan di runner x86_64 dan bisa SSH ke VPS, tapi worker dijalankan
dari repo — jadi binary worker yang dibangun di CI akan basi. Solusi: **worker
dijalankan dari source** (`bun`), binary hanya untuk server.

Bootstrap `bun` di VPS = bagian dari cut-over (dipilih: wrapper, bukan systemd,
supaya rollback = tukar file saja):

```bash
# sekali saja, dijalankan saat cut-over (bukan fitur baru yang berjalan tiap tick)
curl -fsSL https://bun.sh/install | bash          # → /home/code/.bun/bin/bun
```

Verifikasi: `bun --version` di shell cron-style (`env -i bash wrapper.sh --dry`).

### 9.4 Urutan cut-over (rollback di setiap langkah)

1. Server (F1–F3) — deploy lewat GHA seperti biasa, tidak menyentuh worker.
2. Worker TS (F4–F6) selesai + tes hijau; jalankan manual
   `bun worker/src/index.ts --dry` dan bandingkan laporan dengan Python di tick yang sama.
3. Install `bun` di VPS bila belum ada.
4. Tukar isi `~/.hermes/scripts/pr-queue-worker.sh` (simpan `.prev`).
   Rollback = `mv .prev .sh`, tanpa perubahan state.
5. Migrasi cron harian: buat `pr-ops-notifier.sh` → `bun worker/src/ops/syncHooks.ts`,
   ubah job `d98760ebee2c`; hapus `pr-ops-notifier.py` + `pr-ai-fixer.py`.
6. Hapus file Python dari repo (`scripts/*.py`), update README + `scripts/README.md`.
7. Verifikasi akhir: satu siklus cron penuh (worker bun) → review → merge; tidak ada
   proses Python yang tersisa (`pgrep -af "pr-queue-worker.py|pr-ops-notifier.py"` kosong).

## 10. Fase (revisi)

Rincian task-per-task (17 task, TDD, tiap task berakhir tes + commit) ada di
`.hermes/plans/2026-09-25-rombak-implementation.md`.

- **FASE 1 server** (Task 1–7): struktur modul + hapus duplikasi/kode mati + perbaikan
  bug S4/S7–S10; antrian dedupe + retry + per-tool model + analytics async;
  deploy entry `src/main.ts` + README.
- **FASE 2 worker TS** (Task 8–16): kerangka (env/lock/state/report), github, git,
  agent, pr/{scan,review,safety,ci,pins,lockfix,autofix,merge,pipeline},
  sync/{config,repos,merge,verify,run}, ops/syncHooks — semuanya + tes bun.
- **FASE 3 cut-over** (Task 17): wrapper cron bun, migrasi cron job harian,
  hapus seluruh Python, update CI + docs, verifikasi satu siklus penuh.

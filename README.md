# PR-Agent Server

GitHub App server for **automated PR review + auto-merge** using a custom LLM
endpoint (9router/Omniroute). Runtime is **Node + TypeScript**, deployed as a
single compiled binary.

## Architecture

```
GitHub webhook → pr-agent-server (Hono, systemd unit, PORT=4023)
    → in-process review queue (dedupe per PR, 2 concurrent)
        → review pipeline (diff → token budget → prompt → LLM)
            → 9router API (custom OpenAI-compatible endpoint)
```

The server listens on `$PORT` (code default `4023`). The only inbound webhook path is `/api/v1/github_webhooks`
(`POST`, HMAC-verified); `POST /setup/callback` completes the GitHub App
manifest flow using `templates/manifest.json`.

## End-to-end flow

Two processes cooperate. The **API** answers GitHub and the dashboard; the
**worker** is a 5-minute tick that decides what to do with each open PR. They
share the database, not a message bus — the worker acts on GitHub directly.

### 1. Webhook → queued review (apps/api)

```
POST /api/v1/github_webhooks            presentation/http/legacy-routes.ts
  → handleWebhook                       application/webhook/handle-webhook.ts
      · verify HMAC, keep only pull_request events
      · enqueue (dedupe per PR)          application/queue/review-queue.ts
  → runJob                              main.ts
      · reviews.start()   → a `queued` history row (visible while it runs)
      · legacy.runReview  → diff → token budget → prompt → LLM → publish
      · reviews.finish()  → success/failed, model + servedModel + headSha
```

`QUEUE_BACKEND=db` swaps the in-process queue for the Postgres-backed one
(`infrastructure/queue/db-review-queue.ts`) so a restart does not lose work.
A failing review **rethrows**: the queue must record `failed`, not `done`.

### 2. PR tick → merge (apps/worker)

`src/index.ts` builds the deps and calls `runTick` (`src/pr/pipeline.ts`). Every
PR walks exactly one path, and each gate ends that PR's turn:

```
pin guard → review/trigger → permanent skip → AI fix → safety → CI
          → mergeable → approve + merge
```

Step bodies live in `pr/steps.ts`, the gates in `pr/gates.ts`, and the
orchestrator only decides the order. Upstream sync for forks is a separate flow
(`src/sync/run.ts`), driven by `syncHooks`.

### 3. Dashboard (apps/web)

Reads review history over oRPC at `/rpc/*`, authenticated with a better-auth
session cookie. The router's types are exported from `apps/api/src/index.ts`
(type-only), so the browser never depends on `@orpc/server`.

### HTTP surface

Mounted in `main.ts`, **in this order** (later entries must not shadow earlier):

| Path                             | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `/api/auth/*`                    | better-auth (sign-in, callback, session)                   |
| `/health`                        | liveness; reports the configured review model              |
| `/setup/callback`                | GitHub App manifest exchange                               |
| `/api/v1/github_webhooks`        | the HMAC-verified GitHub webhook (`/` is the legacy alias) |
| `/api/v1/notify_review`          | worker ops notice relayed to Discord (`POST`, loopback)    |
| `/api/metrics`, `/api/analytics` | JSONL analytics read-back                                  |
| `/rpc/*`                         | oRPC procedures (dashboard)                                |
| `/api/docs`, `/api/docs/spec`    | OpenAPI UI and spec                                        |
| `/*`                             | SPA fallback, only when `WEB_DIST_PATH` is set             |

Routes are registered with `app.all` where the handler needs to answer any
method (`/health`, `/setup/callback`, the analytics paths); the webhook is
`POST` on both of its paths.

## Project Layout

```
pr-agent-server/
├── apps/api/                # Hono/oRPC GitHub App server (@pr-agent/api)
│   ├── src/
│   │   ├── main.ts          # Hono composition root — route mounting order matters
│   │   ├── migrate.ts       # standalone migration runner (deploy step)
│   │   ├── cli.ts           # one-shot CLI: review / describe / improve
│   │   ├── domain/          # framework-free entities + port interfaces
│   │   ├── application/     # use cases: review, webhook, queue, analytics
│   │   ├── infrastructure/  # adapters: db, github, llm, auth, config
│   │   ├── presentation/    # oRPC routers + the raw legacy HTTP routes
│   │   ├── legacy/          # ported pure modules: prompts, diff, core, tools
│   │   └── db/seed.ts       # one-shot admin seed (idempotent)
│   ├── drizzle/             # committed migrations — the only schema a deploy applies
│   ├── test/                # Vitest suites
│   └── e2e.ts               # live end-to-end against real GitHub + LLM
├── apps/worker/             # 5-minute PR loop (@pr-agent/worker)
├── apps/web/                # Review history SPA (@pr-agent/web)
│   └── src/
│       ├── routes/          # TanStack Router file-based routes
│       ├── components/ui/   # design-system primitives
│       └── libs/{orpc,auth,tanstack-query}/
├── deploy/                  # systemd units (server + worker timers)
├── scripts/                 # deploy helpers
│   ├── deploy-worker.sh
│   └── smoke_hermes_api_server.py
├── templates/manifest.json  # GitHub App manifest template
├── .github/workflows/       # ci.yml (PR gate), deploy.yml
├── .editorconfig
├── .gitignore
├── CONTRIBUTING.md
└── README.md
```

## Development

### Prerequisites

- Node 24.21.0+ (runtime), pnpm 10.33.2+
- GitHub App credentials (App ID, private key, webhook secret)
- 9router/OpenAI-compatible key for the LLM

### Local testing

```bash
pnpm install
pnpm exec biome check .     # lint + format
moon run :typecheck         # tsc --noEmit across all three apps
moon run :test              # 500 tests across apps/api and apps/worker
pnpm -C apps/api exec tsx src/cli.ts --tool review --repo <owner>/<repo> --pr <n> --no-publish
```

### Run server (after setting up secrets)

```bash
# Secrets are resolved at startup: PR_AGENT_APP_ID, private key path,
# omniroute key file (see src/infrastructure/config/ key resolution)
pnpm -C apps/api dev            # starts on $PORT (default 4023)
```

### Local database (no Docker required)

```bash
node apps/api/scripts/dev-stack.mjs --port 5433
# then: DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres
```

The canonical dev database is the Postgres in `docker-compose.dev.yml`. This
harness is the fallback for hosts without Docker: it puts PGlite — Postgres
compiled to WASM — behind the Postgres wire protocol, so the app talks to it
with the ordinary `pg` driver. It applies the committed migrations on start.

### Test tools end-to-end (real GitHub + LLM)

```bash
pnpm -C apps/api exec tsx e2e.ts --repo asepharyana/nextjs-template --pr 19 --publish
pnpm -C apps/api exec tsx src/cli.ts --tool describe --repo <owner>/<repo> --pr <n>
pnpm -C apps/api exec tsx src/cli.ts --tool improve  --repo <owner>/<repo> --pr <n>
```

## Deployment

Deploy is fully automated via GitHub Actions on push to `main`:

```text
# .github/workflows/deploy.yml
1. build-and-deploy → pnpm install → lint → typecheck → tests → build
   → pnpm deploy --prod (self-contained node_modules) → tar → scp to VPS
   → swap /opt/pr-agent-server/{dist,node_modules,drizzle,web-dist}
   → node dist/migrate.js → restart pr-agent-server.service
   → health check on :4023
2. cleanup → Nix GC on VPS (`nix-gc-vps.sh`, non-fatal)
```

The production server is compiled output run by Node
(`/opt/node/bin/node /opt/pr-agent-server/dist/main.js`) as a systemd service
(`pr-agent-server.service`, port 4023, secrets via `bws-exec pr-agent`). The
previous tree is kept as `.prev` for a manual rollback. The runtime has no Nix
dependency — the `cleanup` job only reaps leftover Nix store entries on the VPS.

Secrets required in GitHub Actions:
- `VPS_HOST` — VPS IP address
- `VPS_USER` — SSH user
- `SSH_PRIVATE_KEY` — SSH private key for deploy user
- `GITEA_TOKEN` — for `mirror-gitea.yml` (pushes a mirror to the Gitea backup)

`ci.yml` needs no secrets — it builds and tests only.

## Ops

- **Health watchdog**: cron `pr-agent-health-watchdog` (every 10 min) → `~/.hermes/scripts/pr-agent-health-check.sh` → curl `http://127.0.0.1:4023/health`
- **Secrets**: systemd `ExecStart=/usr/local/bin/bws-exec pr-agent env PORT=4023 /opt/node/bin/node /opt/pr-agent-server/dist/main.js`
- **Prometheus**: `GET /api/metrics` → `pr_agent_requests_total`, `pr_agent_model_failures`
- **Analytics**: `GET /api/analytics` → JSON summary (legacy `pr-agent.*.log` + `pr-agent.bun.jsonl`)
- **Discord**: `POST /api/v1/notify_review` → pr-agent-ops webhook
- **API docs**: `GET /api/docs` for the oRPC surface, `/api/docs/spec` for the OpenAPI document
- **Admin seed**: `pnpm db:seed` with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` — creates the single admin the dashboard authenticates as

## Legacy (Python/Nix — retired 2026-09-21)

The original Python `pr_agent` server (FastAPI + Nix build, port 4002) is fully
retired: its systemd unit, venv, `src/*.py`, `scripts/setup_*` and flake are all
gone from the repo. The Python cron worker was ported to TypeScript and now runs
as `apps/worker/` on Node, from `/opt/pr-agent-worker/dist/index.js`.

## License

MIT.

## Releases and container images

Every push to `main` is analysed by [semantic-release](https://semantic-release.gitbook.io/).
The commit prefix decides the version bump — nobody types a version number:

| Commit                                             | Result                           |
| -------------------------------------------------- | -------------------------------- |
| `feat(scope): …`                                   | minor bump                       |
| `fix(scope): …`                                    | patch bump                       |
| `BREAKING CHANGE:` in the footer                   | major bump                       |
| `chore`, `ci`, `docs`, `refactor`, `test`, `build` | patch bump, or no release at all |

A release publishes a tag, a GitHub Release and the changelog. The same workflow
then builds and pushes one container image per service to GHCR at exactly that
version, so an image tag always matches a git tag:

This repo publishes 3 image(s):

| Package           | Image                                           |
| ----------------- | ----------------------------------------------- |
| `pr-agent-api`    | `ghcr.io/asepharyana/pr-agent-api:<version>`    |
| `pr-agent-worker` | `ghcr.io/asepharyana/pr-agent-worker:<version>` |
| `pr-agent-web`    | `ghcr.io/asepharyana/pr-agent-web:<version>`    |

Pull one without touching the registry UI:

```bash
docker pull ghcr.io/asepharyana/<service>:<version>
```

### Adding or removing an image

Do not edit `.github/workflows/release.yml` to change which images are built.
The list lives in `.github/docker-images.json`:

```json
{ "images": [{ "package": "<service>", "context": ".", "file": "Dockerfile" }] }
```

- `package` becomes the GHCR path component, so it must be lowercase
  `[a-z0-9._-]`. It does not have to match the repo name.
- `context` is the build context directory, `file` the Dockerfile within it.
- `build_args` is an object of `KEY=value` pairs; the pipeline flattens it before
  the matrix, so both the object and a pre-joined `"A=1\nB=2"` string work.
- `"enabled": false` keeps an entry documented but skips building it. **An empty
  or fully disabled list fails the run** rather than publishing nothing.

Every enabled entry must have a `Dockerfile` **and** a `.dockerignore` in its
context, and both must be tracked by git — CI cannot see an untracked file, and a
missing `.dockerignore` silently ships `node_modules/` and `.git` inside the image.

`latest` tracks the newest stable release. Prereleases (`1.2.0-rc.1`) are
tagged but never promote `latest`.

### If a release fails

Check the run, then fix forward with a normal commit — do not re-tag by hand:

```bash
gh run list --workflow=release.yml --limit 5
gh run view <run-id> --log-failed
```

A run that only built images and published no tag is normal for a `chore` push:
there was nothing to release, so no version was derived and no image was tagged.

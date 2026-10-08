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

```yaml
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

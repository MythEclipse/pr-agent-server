# PR-Agent Server

GitHub App server for **automated PR review + auto-merge** using a custom LLM
endpoint (9router/Omniroute). Runtime is **Bun + TypeScript**, deployed as a
single compiled binary.

## Architecture

```
GitHub webhook → pr-agent-bun (Bun.serve, systemd unit, PORT=4023)
    → in-process review queue (dedupe per PR, 2 concurrent)
        → review pipeline (diff → token budget → prompt → LLM)
            → 9router API (custom OpenAI-compatible endpoint)
```

The server listens on `$PORT` (code default `3000`; the systemd unit sets
`PORT=4023`). The only inbound webhook path is `/api/v1/github_webhooks`
(`POST`, HMAC-verified); `POST /setup/callback` completes the GitHub App
manifest flow using `templates/manifest.json`.

## Project Layout

```
pr-agent-server/
├── server/                  # TypeScript/Bun GitHub App server
│   ├── src/
│   │   ├── main.ts          # entry: `if (import.meta.main) startServer()`
│   │   ├── cli.ts           # one-shot CLI: review / describe / improve
│   │   ├── config.ts        # env + key resolution
│   │   ├── llm.ts           # chatCompletion + callWithFallback (retry per model)
│   │   ├── queue.ts         # in-process review queue: dedupe + concurrency cap
│   │   ├── analytics.ts     # async serialized jsonl writer
│   │   ├── core/            # token, render (templates), yaml, markdown
│   │   ├── diff/            # hunk/extend/filter/budget/multi
│   │   ├── github/          # client, provider, large-diff
│   │   ├── http/            # server, webhook, notify, analytics, setup
│   │   ├── notify/discord.ts  # HTML→Discord plain text + webhook poster
│   │   ├── prompts/         # review, describe, suggestions
│   │   └── tools/           # review, describe, improve, publish
│   ├── test/                # bun:test suites
│   └── e2e.ts               # live end-to-end against real GitHub + LLM
├── scripts/                 # setup/deploy helpers + the PR queue cron worker
│   ├── pr-queue-worker.py   # cron worker (Python today; being migrated to TS)
│   ├── smoke_hermes_api_server.py
│   └── test_pr_queue_sync.py
├── templates/manifest.json  # GitHub App manifest template
├── .github/workflows/       # deploy.yml (Bun CI), mirror-gitea.yml
├── .editorconfig
├── .gitignore
├── CONTRIBUTING.md
└── README.md
```

## Development

### Prerequisites
- Bun 1.3.14+ (runtime + build)
- GitHub App credentials (App ID, private key, webhook secret)
- 9router/OpenAI-compatible key for the LLM

### Local testing

```bash
cd server
bun install
bunx tsc --noEmit          # typecheck
bun test                   # unit tests (48 tests)
bun src/cli.ts --tool review --repo <owner>/<repo> --pr <n> --no-publish
```

### Run server (after setting up secrets)

```bash
# Secrets are resolved at startup: PR_AGENT_APP_ID, private key path,
# omniroute key file (see src/config.ts key resolution)
cd server
bun src/main.ts            # starts on $PORT (code default 3000)
```

### Test tools end-to-end (real GitHub + LLM)

```bash
bun e2e.ts --repo asepharyana/nextjs-template --pr 19 --publish
bun src/cli.ts --tool describe --repo <owner>/<repo> --pr <n>
bun src/cli.ts --tool improve  --repo <owner>/<repo> --pr <n>
```

## Deployment

Deploy is fully automated via GitHub Actions on push to `main`:

```yaml
# .github/workflows/deploy.yml
1. build-and-deploy → bun install → typecheck → tests → bun build --compile
   → scp binary to VPS → swap /opt/pr-agent-server/bin/pr-agent-bun
   → restart pr-agent-bun.service → health check on :4023
2. cleanup → Nix GC on VPS (`nix-gc-vps.sh`, non-fatal)
```

The production server is a single compiled binary
(`/opt/pr-agent-server/bin/pr-agent-bun`) running as a systemd service
(`pr-agent-bun.service`, port 4023, secrets via `bws-exec pr-agent`). The
runtime has no Nix dependency — the `cleanup` job only reaps leftover Nix
store entries on the VPS.

Secrets required in GitHub Actions:
- `VPS_HOST` — VPS IP address
- `VPS_USER` — SSH user
- `SSH_PRIVATE_KEY` — SSH private key for deploy user
- `GITEA_TOKEN` — for Gitea mirror (if using mirror workflow)

## Ops

- **Health watchdog**: cron `pr-agent-health-watchdog` (every 10 min) → `~/.hermes/scripts/pr-agent-health-check.sh` → curl `http://127.0.0.1:4023/health`
- **Secrets**: systemd `ExecStart=/usr/local/bin/bws-exec pr-agent env PORT=4023 /opt/pr-agent-server/bin/pr-agent-bun`
- **Prometheus**: `GET /api/metrics` → `pr_agent_requests_total`, `pr_agent_model_failures`
- **Analytics**: `GET /api/analytics` → JSON summary (legacy `pr-agent.*.log` + `pr-agent.bun.jsonl`)
- **Discord**: `POST /api/v1/notify_review` → pr-agent-ops webhook

## Legacy (Python/Nix — retired 2026-09-21)

The original Python `pr_agent` server (FastAPI + Nix build, port 4002) is fully
retired: its systemd unit, venv, `src/*.py`, `scripts/setup_*` and flake are all
gone from the repo. The Bun binary replaced the server end-to-end. The Python
cron worker in `scripts/` is still live in production and is being migrated to
TypeScript.

## License

MIT.

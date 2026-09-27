# PR Queue Worker

`worker/` (TypeScript/Bun) — the 5-minute job that watches open PRs across every
repo where the PR-Agent GitHub App is installed, and drives the full lifecycle:

1. **Open PR found** → ensure a PR-Agent review exists (fabricates a webhook to
   `pr-agent.asepharyana.my.id` if not)
2. **Toolchain pin guard** → closes dependabot PRs that bump pinned toolchain
   majors (see `TOOLCHAIN_PINS` in `worker/src/pr/lockfix.ts`) instead of
   waiting on them forever
3. **AI auto-fix** → runs the Hermes agent via the local gateway API server
   (`POST /v1/chat/completions`, `API_SERVER_KEY`) on the PR head for up to
   `AI_FIX_MAX_TURNS` turns, commits locally, then the worker pushes the fix
4. **Safety analysis** → parses the review body for security/major-issue
   blockers; score must be ≥ 6/10
5. **CI gate** → waits for the required check to pass (closes stale dependabot
   PRs stuck failing CI for > `STALE_CI_CLOSE_DAYS`)
6. **Approve + merge**

The same tick also runs two side jobs: `ops/syncHooks.ts` (keeps every fork's
Dependabot config and the PR-Agent webhook in sync) and the upstream fork
auto-sync below.

## Upstream Fork Auto-Sync

Every repo in the App installation whose GitHub metadata says `fork: true`: new
upstream (parent) commits are **merged** (never rebased) into the fork's default
branch, gated by a per-repo interval (default **1 hour**; the `UPSTREAM_SYNC`
config block in `worker/src/sync/config.ts`).

- **Conflicted merge** → the Hermes agent (via the gateway API server) resolves
  it (merge-reconciler rules: merge hunks by hand, never wholesale
  `--ours/--theirs`, run the repo's own typecheck/tests before committing). The
  agent never pushes — the harness does.
- **Clean merge** → one Hermes quality pass over the merged files, committed as
  `fix: auto-fix code quality [skip ci]`.
- **Protected default branch** → detected by a read-only branch-protection
  lookup; when protected, the sync falls back to opening an `upstream-sync-*` PR
  that the normal pipeline (review → AI fix → CI → approve → merge) finishes.
- **CI safety** → after a direct push the worker verifies the fork's CI at our
  merge commit; a red CI at OUR merge sha (still the tip, no human commits on
  top) force-reverts to the pre-merge sha. Watch stops after 6 h.
- **Push credentials** → owner PAT (gh CLI) first because the App lacks
  `workflows:write`; App token is the fallback. Clones use the App token.
- **State** → `/tmp/pr-queue-sync-state.json` (skip/interval/pending-verify),
  workdirs `/tmp/pr-queue-sync-work/`. The format is unchanged from the Python
  worker on purpose, so an old state file is still readable after cut-over.
- **Notifications** → same `pr-agent-ops` Discord webhook: synced, PR opened,
  reverted, skipped-once.

## Development

The worker's source is `worker/`. Run it straight from the checkout:

```bash
cd worker
bun install
bunx tsc --noEmit
bun test
bun src/index.ts --sync-status                    # read-only, needs no credentials
bun src/index.ts --sync-only --dry                # stops before any push
bun src/index.ts                                  # one full tick
bun src/index.ts --sync-hooks                     # refused unless gated, see below
```

### `--sync-hooks` is gated, and stays that way

`--sync-hooks` writes the pr-agent webhook and three Dependabot files to **every
repo the GitHub token can see**. It refuses to run unless
`PR_AGENT_SYNC_HOOKS=1` is set — any other value, including `true` or `yes`, is
rejected, and the check happens before a key file is read or a request is made.

That gate is not a placeholder. The Dependabot templates in
`worker/src/ops/templates/` were written from scratch during the TypeScript
migration, because the Python that previously managed fleet config was already
deleted. Nothing in the repo or in git history records what the previous
operator wanted written to every fork.

**Read those three files before enabling the gate.** Turning it on is a
configuration decision with fleet-wide consequences, not a code change.

Once enabled, `pr-agent-sync-hooks.timer` runs it daily at 03:17 (plus up to 15
minutes of randomised delay, because every other timer on this host fires near
the top of the hour).

```bash
sudo systemctl start pr-agent-sync-hooks.service        # run once, now
sudo journalctl -u pr-agent-sync-hooks.service -n 40
```

## Deployment

The worker is **deployed as a systemd timer on the VPS**, not as a cron job.

| | |
|---|---|
| Unit | `pr-agent-worker.service` (`Type=oneshot`) |
| Timer | `pr-agent-worker.timer` — `OnBootSec=2min`, `OnUnitActiveSec=5min` |
| Deployed code | `/opt/pr-agent-worker/` (`src/`, `test/`, `bin/bun`) |
| Entrypoint | `/opt/pr-agent-worker/run-worker.sh` |
| User | `pr-agent` |
| Logs | `journalctl -u pr-agent-worker.service` |

A second pair, `pr-agent-sync-hooks.{service,timer}`, runs the daily fork-config
sync and is gated — see `--sync-hooks` above. Both pairs are in `deploy/` so the
deployment can be rebuilt from the repo alone.

```bash
sudo systemctl list-timers pr-agent-worker.timer
sudo systemctl start pr-agent-worker.service   # run one tick now
sudo journalctl -u pr-agent-worker.service -f
```

**Why `/opt` and not this checkout:** the `pr-agent` user cannot read
`/home/code` (mode 750), so a checkout-based deploy cannot execute at all — bun
itself lives at `/opt/pr-agent-worker/bin/bun` for the same reason. `/opt` is
where the webhook server's binary already lives, so the two halves of this
system share one deploy location.

**Why a timer and not a cron job:** a periodic job has no reason to be resident
between ticks. `OnUnitActiveSec` is measured from the end of the previous run,
so a slow tick cannot stack up behind itself.

### Secrets

Nothing is baked into the image or the unit file. `/opt/pr-agent-worker/run-worker.sh`
runs under `bws-exec pr-agent`, which fetches the environment from Bitwarden
Secrets Manager at start-up, and maps the two names the worker expects onto the
ones already in that secret set:

| Worker expects | Provided by BWS as | Why not renamed |
|---|---|---|
| `PR_AGENT_APP_ID` | `GITHUB_APP_ID` | same App, shared with the webhook server |
| `PR_AGENT_WEBHOOK_SECRET` | `GITHUB_WEBHOOK_SECRET` | same webhook, shared with the server |

Non-secret values are plain `Environment=` lines in the unit:
`PR_AGENT_KEY_PATH=/var/lib/pr-agent-server/private-key.pem`,
`PR_AGENT_APP_DIR=/var/lib/pr-agent-server`, and `PR_AGENT_WEBHOOK_URL`.

The mapping **must** happen inside the wrapper, not in the unit's `ExecStart`:
systemd expands `$VAR` in `ExecStart` against its own environment, which does
not contain the Bitwarden secrets (`bws-exec` only exports them inside the
process it execs). Written the naive way the worker would receive the literal
string `$GITHUB_APP_ID` and fail every signed call with a confusing 401.

### Keeping the deployed copy in sync

`/opt/pr-agent-worker/` is a copy, not a symlink — it must be re-copied after
any change to `worker/`:

```bash
sudo rsync -a --delete /home/code/pr-agent-server-wt/worker/src/  /opt/pr-agent-worker/src/
sudo chown -R pr-agent:pr-agent /opt/pr-agent-worker
sudo systemctl start pr-agent-worker.service   # then check the journal
```

CI (`.github/workflows/deploy.yml`) typechecks and tests `worker/` on every
manual run, so a break is caught before it reaches the timer.

## Python history

`scripts/pr-queue-worker.py` and `scripts/test_pr_queue_sync.py` were removed
when this worker was ported to TypeScript. Behavioural parity with them is the
contract that governed the port: string literals, regexes, thresholds, git
argument vectors, truncation widths and error-swallowing semantics were carried
over as-is. Where the port deliberately diverges, the code says why at the site.

`scripts/smoke_hermes_api_server.py` is unrelated to the queue worker — it
smoke-tests the Hermes gateway API server and is still Python on purpose.

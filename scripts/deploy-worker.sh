#!/usr/bin/env bash
# Re-deploy the PR queue worker to /opt/pr-agent-worker and prove it still runs.
#
# The deployed tree is a COPY, not a symlink, so this is what keeps it honest
# after a change to apps/worker/. The pr-agent user cannot read /home/code, so the
# worker cannot run from the checkout at all — which is exactly why this exists.
#
# Usage: scripts/deploy-worker.sh [--no-tick]
#   --no-tick   deploy without running a tick (for CI or a dry review)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-/opt/node/bin/node}"
SRC="$REPO/apps/worker"
DEST=/opt/pr-agent-worker
RUN_TICK=1
[[ "${1:-}" == "--no-tick" ]] && RUN_TICK=0

[[ -d "$SRC/src" ]] || { echo "deploy-worker: $SRC/src missing" >&2; exit 1; }

echo "==> syncing $SRC -> $DEST"
sudo install -d -m 0755 "$DEST"

# The deployed tree is COMPILED OUTPUT since the Node migration: deploy.yml (or
# a local `pnpm run build`) produces dist/, and that is what the unit execs.
if [[ ! -d "$SRC/dist" ]]; then
  echo "deploy-worker: $SRC/dist missing — run 'pnpm run build' first" >&2
  exit 1
fi
sudo rsync -a --delete "$SRC/dist/" "$DEST/dist/"
sudo install -m 0644 "$SRC/package.json" "$DEST/package.json"

# run-worker.sh is the ExecStart of BOTH units (pr-agent-worker.service and
# pr-agent-sync-hooks.service) and it carries the $GITHUB_APP_ID mapping that both
# unit files' comments call load-bearing. It was previously absent from git
# entirely, so a rebuild from the repo produced two units pointing at a file that
# did not exist. Install it with a hard failure if the source is missing, rather
# than a deploy that looks fine and breaks on the next tick.
if [[ -f "$SRC/run-worker.sh" ]]; then
  sudo install -m 0755 "$SRC/run-worker.sh" "$DEST/run-worker.sh"
else
  echo "deploy-worker: $SRC/run-worker.sh is missing and BOTH units ExecStart it" >&2
  exit 1
fi

# Node must live somewhere pr-agent can execute, and /home/code is not.
if [[ ! -x /opt/node/bin/node ]]; then
  echo "deploy-worker: /opt/node/bin/node missing — install Node 24 there first" >&2
  exit 1
fi
sudo chmod 0755 "$DEST"
sudo chown -R pr-agent:pr-agent "$DEST"

# The worker runs as pr-agent, and every state path it owns is an absolute /tmp
# path inherited from the Python. A file there owned by anyone else is
# UNWRITABLE, and the failure is silent: the save throws, is caught by the
# error-swallowing tick, and the next tick redoes the same work forever. This
# actually happened -- /tmp/pr-queue-sync-state.json was left owned by `code` at
# mode 0644, so pr-agent could read it and never write it.
echo "==> checking state paths are writable by pr-agent"
for f in /tmp/pr-queue-sync-state.json /tmp/pr-queue-fix-state.json; do
  if [[ -e "$f" ]] && ! sudo -u pr-agent test -w "$f"; then
    echo "==> $f is not writable by pr-agent; handing it over"
    sudo chown pr-agent:pr-agent "$f"
    sudo chmod 0664 "$f"
  fi
done

# The deployed tree is compiled output now, so there is no suite to run there.
# Test the CHECKOUT before its build is copied — which is the same guarantee in
# the other order: nothing reaches $DEST that did not pass first.
#
# `pnpm test`, not `node --test`. The suite moved off bun:test to Vitest in the
# Node migration, and Node's built-in runner discovers none of it: it reported
# success having run zero tests, so this gate was not a gate at all.
#
# As `code`, NOT as pr-agent. /home/code is mode 750 code:code, so pr-agent
# cannot even traverse into the checkout — `pnpm test` there fails EACCES
# opening apps/worker/package.json. That was not a flake; it made this script
# unusable while still exiting non-zero, so it refused to deploy every time.
echo "==> testing the checkout before the copy is trusted"
( cd "$SRC" && pnpm test ) 2>&1 | tail -8 || {
  echo "deploy-worker: the test suite failed — refusing to deploy" >&2
  exit 1
}

echo "==> verifying the deployed copy is readable by pr-agent"
sudo -u pr-agent head -c 1 "$DEST/package.json" >/dev/null || {
  echo "deploy-worker: pr-agent cannot read $DEST/package.json — the unit would EACCES" >&2
  exit 1
}

if [[ $RUN_TICK -eq 0 ]]; then
  echo "==> skipping tick (--no-tick)"
  exit 0
fi

echo "==> running one tick"
sudo systemctl start pr-agent-worker.service
sleep 2
sudo systemctl show pr-agent-worker.service -p Result -p ExecMainStatus
sudo journalctl -u pr-agent-worker.service -n 15 --no-pager | tail -10

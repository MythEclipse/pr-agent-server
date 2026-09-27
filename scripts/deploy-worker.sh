#!/usr/bin/env bash
# Re-deploy the PR queue worker to /opt/pr-agent-worker and prove it still runs.
#
# The deployed tree is a COPY, not a symlink, so this is what keeps it honest
# after a change to worker/. The pr-agent user cannot read /home/code, so the
# worker cannot run from the checkout at all — which is exactly why this exists.
#
# Usage: scripts/deploy-worker.sh [--no-tick]
#   --no-tick   deploy without running a tick (for CI or a dry review)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/worker"
DEST=/opt/pr-agent-worker
RUN_TICK=1
[[ "${1:-}" == "--no-tick" ]] && RUN_TICK=0

[[ -d "$SRC/src" ]] || { echo "deploy-worker: $SRC/src missing" >&2; exit 1; }

echo "==> syncing $SRC -> $DEST"
sudo install -d -m 0755 "$DEST/src" "$DEST/test" "$DEST/bin"
sudo rsync -a --delete "$SRC/src/"  "$DEST/src/"
sudo rsync -a --delete "$SRC/test/" "$DEST/test/"

# The lockfile and tsconfig are needed to typecheck/test the deployed copy.
for f in package.json bun.lock tsconfig.json; do
  [[ -f "$SRC/$f" ]] && sudo install -m 0644 "$SRC/$f" "$DEST/$f"
done

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

# Bun must live somewhere pr-agent can execute, and /home/code is not.
if [[ ! -x "$DEST/bin/bun" ]]; then
  echo "==> installing bun into $DEST/bin (pr-agent cannot read ~/.bun)"
  sudo install -m 0755 "$(command -v bun)" "$DEST/bin/bun"
fi
sudo chmod 0755 "$DEST" "$DEST/bin" "$DEST/bin/bun"
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

echo "==> typechecking + testing the DEPLOYED copy (not the checkout)"
( cd "$DEST" && sudo -u pr-agent ./bin/bun test ) 2>&1 | tail -5

if [[ $RUN_TICK -eq 0 ]]; then
  echo "==> skipping tick (--no-tick)"
  exit 0
fi

echo "==> running one tick"
sudo systemctl start pr-agent-worker.service
sleep 2
sudo systemctl show pr-agent-worker.service -p Result -p ExecMainStatus
sudo journalctl -u pr-agent-worker.service -n 15 --no-pager | tail -10

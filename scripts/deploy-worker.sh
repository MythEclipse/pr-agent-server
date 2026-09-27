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

# Bun must live somewhere pr-agent can execute, and /home/code is not.
if [[ ! -x "$DEST/bin/bun" ]]; then
  echo "==> installing bun into $DEST/bin (pr-agent cannot read ~/.bun)"
  sudo install -m 0755 "$(command -v bun)" "$DEST/bin/bun"
fi
sudo chmod 0755 "$DEST" "$DEST/bin" "$DEST/bin/bun"
sudo chown -R pr-agent:pr-agent "$DEST"

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

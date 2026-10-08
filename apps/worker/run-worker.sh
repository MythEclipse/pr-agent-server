#!/usr/bin/env bash
# Run the PR queue worker with the GitHub App credentials.
#
# WHY THIS EXISTS instead of putting `PR_AGENT_APP_ID=$GITHUB_APP_ID` straight
# into the unit's ExecStart: systemd expands `$VAR` in ExecStart against its OWN
# environment, which does not contain the Bitwarden secrets — bws-exec only
# exports them inside the process it execs. Written the naive way, the worker
# would receive the literal string "$GITHUB_APP_ID" as its App id and fail every
# signed API call with a confusing 401. The mapping therefore has to happen in a
# shell that runs AFTER bws-exec has exported the real values.
set -euo pipefail

# Node is installed under /opt/node by the deploy, NOT in a user home: the
# pr-agent user cannot read /home/code (mode 750), so a node under the user home
# would fail with EACCES.
NODE_BIN="${NODE_BIN:-/opt/node/bin/node}"

# The App id and the webhook secret are stored under the server's names, so they
# are mapped rather than duplicated as new BWS entries.
export PR_AGENT_APP_ID="${GITHUB_APP_ID:?GITHUB_APP_ID missing from BWS}"
export PR_AGENT_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:?GITHUB_WEBHOOK_SECRET missing from BWS}"

# The worker refuses to run without a token; fail here with a clear message
# rather than deep inside the worker's first API call.
if [[ -z "${PR_AGENT_APP_ID}" ]]; then
  echo "pr-agent-worker: no App id — refusing to run" >&2
  exit 1
fi

exec "$NODE_BIN" /opt/pr-agent-worker/dist/index.js "$@"
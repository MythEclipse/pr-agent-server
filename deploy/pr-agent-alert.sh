#!/bin/sh
# Tell someone that a pr-agent unit failed.
#
# WHY THIS EXISTS. Every unit here is `Type=oneshot` under a timer, and none of
# them had `OnFailure=`. A failed run left exactly one trace: a `Result:
# exit-code` line in the journal. Measured on this box — the first live
# `--fix-vulns` run failed three plans and nobody knew until the journal was read
# by hand hours later, and an earlier gate refusal had been breaking the nightly
# sync for three nights unnoticed.
#
# Silent failure is the one failure mode automation cannot recover from on its
# own: everything downstream keeps looking healthy because nothing is running.
#
# CONFIGURATION, in /etc/pr-agent/alert.env (root:root 0600):
#
#   PR_AGENT_ALERT_URL=...        any endpoint that accepts a JSON POST. Discord
#                                 and Slack incoming webhooks both take `content`
#                                 and `text`; both keys are sent.
#   PR_AGENT_HEALTHCHECK_URL=...  optional dead-man switch. When set, every
#                                 SUCCESSFUL run pings it (see run-worker.sh), so
#                                 the absence of a ping is the alarm — that is the
#                                 only way to notice a timer that stopped firing
#                                 entirely, which OnFailure= cannot see.
#
# WITH NO URL CONFIGURED this writes to stderr and exits 0: a notification
# channel that is missing must not itself be reported as a second failure.
set -eu

UNIT="${1:-unknown}"
# `%N` expands without the type suffix; journalctl wants the full unit name.
case "$UNIT" in
	*.*) ;;
	*) UNIT="$UNIT.service" ;;
esac
[ -f /etc/pr-agent/alert.env ] && . /etc/pr-agent/alert.env

# The last lines of the unit's own journal are the only useful payload: "the unit
# failed" without the error is a message the reader has to go and investigate
# anyway.
TAIL="$(journalctl -u "$UNIT" -n 12 --no-pager -o cat 2>/dev/null || true)"
HOST="$(hostname 2>/dev/null || echo unknown)"
BODY="pr-agent: **${UNIT}** failed on ${HOST}
\`\`\`
${TAIL}
\`\`\`"

if [ -z "${PR_AGENT_ALERT_URL:-}" ]; then
	echo "pr-agent-alert: no PR_AGENT_ALERT_URL configured; ${UNIT} failed" >&2
	echo "$BODY" >&2
	exit 0
fi

# JSON-escape the body without needing jq: backslash, quote, and newlines.
escaped="$(printf '%s' "$BODY" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "%s\\n", $0}')"
payload="{\"content\":\"${escaped}\",\"text\":\"${escaped}\"}"

# One attempt with a short timeout. If the channel is down, the journal entry
# below is the record; retrying here would just delay the unit's exit.
if curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" "$PR_AGENT_ALERT_URL" >/dev/null 2>&1; then
	echo "pr-agent-alert: reported ${UNIT} failure to the configured webhook"
else
	echo "pr-agent-alert: webhook delivery FAILED for ${UNIT}" >&2
	echo "$BODY" >&2
fi

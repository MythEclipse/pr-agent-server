/**
 * Resolution of the `pr-agent-ops` Discord webhook, shared by the two callers
 * that post to it: the per-tick report (`report.ts`) and the upstream-sync
 * notifier (`discord.ts`). Both used to carry a byte-identical copy of this
 * lookup, so the precedence rule lived in two places.
 *
 * Resolution order, highest first:
 *
 *   1. `$HERMES_HOME/.ops-webhooks.json["pr-agent-ops"]`, falling back to
 *      `~/.hermes/.ops-webhooks.json[...]`. Python hardcoded `~/.hermes`;
 *      HERMES_HOME is honoured at CALL time so this stays redirectable in a
 *      test.
 *   2. `DISCORD_WEBHOOK_URL`, the same channel the webhook server posts review
 *      notifications to (README: "notify_review -> pr-agent-ops webhook").
 *
 * WHY (2) IS NEEDED. The worker runs as `pr-agent` with
 * `HOME=/var/lib/pr-agent-server`, and no `.ops-webhooks.json` is installed
 * there. (1) therefore hit a missing file on every single tick: `readFileSync`
 * threw, the catch returned "", and the caller could not tell "unconfigured"
 * from "Discord unreachable" — so every per-tick ops report was discarded with
 * no trace anywhere. `bws-exec` already exports `DISCORD_WEBHOOK_URL` into the
 * worker's environment, and it is that same webhook, so the fallback restores
 * the channel without adding a secret to the vault or a file to the box.
 *
 * Both sources are best-effort by contract: returns "" for a missing file,
 * malformed JSON, a non-object document, or an absent/non-string key. A tick
 * must never die because its notifier could not find a URL.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** The `pr-agent-ops` key inside the Hermes ops-webhook config document. */
const CONFIG_KEY = "pr-agent-ops"

/** The webhook URL, or "" when no source yields one. Never throws. */
export function opsWebhookUrl(): string {
	return configFileUrl() ?? process.env.DISCORD_WEBHOOK_URL ?? ""
}

/** The URL from the ops-webhook config document, or undefined if unusable. */
function configFileUrl(): string | undefined {
	const path = join(process.env.HERMES_HOME ?? join(homedir(), ".hermes"), ".ops-webhooks.json")
	let url: unknown
	try {
		const cfg = JSON.parse(readFileSync(path, "utf8")) as unknown
		if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) return undefined
		url = (cfg as Record<string, unknown>)[CONFIG_KEY]
	} catch {
		return undefined
	}
	return typeof url === "string" ? url : undefined
}

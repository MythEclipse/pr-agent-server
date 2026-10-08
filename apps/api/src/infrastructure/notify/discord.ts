// Discord notification plumbing: HTML → Discord-friendly plain text and the
// webhook poster. Never raises — notifications must not break the review path.

/** Strip HTML table markup down to Discord-friendly plain text.
 *  Discord embeds render limited markdown — raw <table>/<td>/<tr> tags
 *  would show as literal HTML. Convert the reviewer table into lines. */
export function htmlToDiscordPlain(html: string): string {
	const s = html
		.replace(/<details>/g, "")
		.replace(/<\/details>/g, "")
		.replace(/<summary>/g, "▶ ")
		.replace(/<\/summary>/g, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/tr>/gi, "\n")
		.replace(/<\/td>/gi, "")
		.replace(/<\/th>/gi, "")
		.replace(/<td[^>]*>/gi, "")
		.replace(/<th[^>]*>/gi, "")
		.replace(/<tr[^>]*>/gi, "")
		.replace(/<table[^>]*>/gi, "")
		.replace(/<\/table>/gi, "")
		.replace(/<li[^>]*>/gi, "• ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
	return s
}

export async function sendDiscord(webhook: string, content: string, title?: string): Promise<void> {
	try {
		await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: "PR-Agent Ops",
				embeds: [{ title, description: content.slice(0, 4000), color: 0x5865f2 }],
			}),
		})
	} catch {
		// never raise
	}
}

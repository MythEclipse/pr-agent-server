// Timestamp formatting for the dashboard.
//
// WHY THIS EXISTS. Every page rendered timestamps as
// `new Date(x).toISOString().slice(0, 16).replace("T", " ")` — which is UTC
// presented with no timezone marker. The operator is in WIB (UTC+7), so every
// review appeared to have happened seven hours earlier than it did, and there was
// nothing on screen to reveal the offset. "When did this review run?" is the
// primary question the history page answers, so a silent 7-hour error actively
// misleads: it makes a review from this morning look like last night's.
//
// The fix is `toLocaleString`, which renders in the VIEWER's timezone, with the
// zone name attached so the value is unambiguous even if the viewer's locale
// differs from the operator's.

/** A date, display-ready, or the em dash placeholder when absent/unparseable. */
export function formatWhen(value: string | Date | null | undefined): string {
	if (!value) return "—"
	const date = value instanceof Date ? value : new Date(value)
	// `new Date("nonsense")` yields an Invalid Date, and toLocaleString on it
	// returns the literal "Invalid Date" — worse than the placeholder.
	if (Number.isNaN(date.getTime())) return "—"
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	})
}

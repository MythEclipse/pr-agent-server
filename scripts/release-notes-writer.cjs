/**
 * semantic-release `writeReleaseNotes` that caps the release body length.
 *
 * GitHub rejects a release whose body exceeds 125,000 characters:
 *
 *   Validation Failed: {"resource":"Release","field":"body",
 *                       "message":"body is too long (maximum is 125000 characters)"}
 *
 * A repository's FIRST release generates notes from its entire history, so the
 * size of that body is a function of how long the repo has existed, not of what
 * just changed. GMW has 1889 untagged commits and its first release body blew
 * past the limit. That failure appears exactly once per repo — on the day the
 * pipeline is installed — and then never again, which makes it very easy to
 * misdiagnose as a transient.
 *
 * The same unbounded body is what pushes `git commit -m` past MAX_ARG_STRLEN
 * (128 KiB per argument), so this cap and the short `message` in
 * .releaserc.json address one class of bug from two directions.
 *
 * Deliberately self-contained: it does NOT reach into
 * @semantic-release/release-notes-generator's internals. That package is ESM
 * with a restricted `exports` map and no public `lib/write.js`, so requiring it
 * pins this file to a private path that a patch release can move — a CI failure
 * on an unrelated dependency bump.
 */

/** Default body-length cap, in characters, when RELEASE_NOTES_LIMIT is unset. */
const DEFAULT_LIMIT = 120000

/** Footer appended in place of the sections that did not fit in the budget. */
const MARKER = "_… earlier changes omitted; see the repository history for the full list._"

/**
 * Resolve the effective body-length cap from the environment.
 *
 * A non-numeric, negative, or zero value would silently disable truncation (or
 * drop every section), so it falls back to the default rather than failing the
 * release.
 *
 * @returns {number} maximum number of characters allowed in the release body
 */
function resolveLimit() {
	const configured = Number(process.env.RELEASE_NOTES_LIMIT || DEFAULT_LIMIT)
	if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_LIMIT
	return configured
}

/**
 * Keep whole Markdown sections from the top of `notes` until the budget is spent.
 *
 * Splitting on a blank line keeps Markdown intact — a slice taken mid-heading
 * emits broken output, which is worse than a shorter body.
 *
 * @param {string} notes       full generated release body
 * @param {number} limit       maximum characters allowed for the whole body
 * @returns {string} truncated body, with an elision marker when sections were dropped
 */
function truncateToBudget(notes, limit) {
	// Reserve room for the marker itself plus a small safety margin, so the
	// elided body still lands under `limit` even on the boundary.
	const budget = limit - MARKER.length - 200
	const sections = notes.split(/\n{2,}/)

	const kept = []
	let size = 0
	for (const section of sections) {
		const cost = section.length + 2
		if (size + cost > budget) break
		kept.push(section)
		size += cost
	}

	// Always keep at least the first section, even if it alone exceeds the budget:
	// a heading plus a truncated marker beats an empty release body.
	if (kept.length === 0) kept.push(sections[0])

	const omitted = sections.length - kept.length
	const elision = omitted > 0 ? `\n\n${MARKER}\n` : ""
	return kept.join("\n\n") + elision
}

/**
 * Build the release body, capped so GitHub accepts it.
 *
 * @param {{nextRelease?: {notes?: string}}} context  semantic-release context
 * @returns {string} markdown release body
 */
function writeReleaseNotes(context) {
	// Under the limit: hand back the generator's own text untouched, so a normal
	// release is byte-identical to what the built-in writer would produce.
	const notes = (context && context.nextRelease && context.nextRelease.notes) || ""
	if (notes.length <= resolveLimit()) return notes

	return truncateToBudget(notes, resolveLimit())
}

module.exports = writeReleaseNotes

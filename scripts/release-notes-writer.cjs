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

/** Fallback cap when RELEASE_NOTES_LIMIT is unset or unusable. */
const DEFAULT_LIMIT = 120000

/** Appended when whole sections had to be dropped to fit under {@link limit}. */
const MARKER = "_… earlier changes omitted; see the repository history for the full list._"

/** Sections are Markdown blocks separated by a blank line. */
const SECTION_SEPARATOR = /\n{2,}/

/**
 * Headroom, in characters, reserved inside the budget for the elision marker,
 * surrounding blank lines and the trailing newline. The elision is accounted
 * for separately; this covers the rest of the assembly slack.
 */
const ASSEMBLY_HEADROOM = 200

/**
 * Resolves the character cap from the environment.
 *
 * An unparseable or non-positive RELEASE_NOTES_LIMIT would otherwise become
 * NaN, and every comparison against NaN is false — the writer would then take
 * the "under the limit" path for arbitrarily large bodies and fail the same way
 * it was written to prevent. Fall back to the default instead.
 *
 * @returns {number} the cap in characters, guaranteed to be a positive number
 */
function resolveLimit() {
	const raw = process.env.RELEASE_NOTES_LIMIT
	if (raw === undefined || raw.trim() === "") return DEFAULT_LIMIT

	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT

	return parsed
}

/**
 * semantic-release `writeReleaseNotes` that caps the release body length.
 *
 * @param {{ nextRelease?: { notes?: string } }} [context] semantic-release context
 * @param {object} [options] plugin options; accepted for signature parity with
 *   @semantic-release/release-notes-generator's own writer, but unused here
 * @returns {string} markdown release body, guaranteed not to exceed the cap
 *   by more than the elision marker's own length
 */
function writeReleaseNotes(context, options) {
	const limit = resolveLimit()
	const notes = context && context.nextRelease ? context.nextRelease.notes : undefined

	if (!notes) return ""

	// Under the limit: hand back the generator's own text untouched, so a normal
	// release is byte-identical to what the built-in writer would produce.
	if (notes.length <= limit) return notes

	// Over the limit: keep whole sections from the top until the budget is spent.
	// Splitting on a blank line keeps Markdown intact — a slice taken mid-heading
	// emits broken output, which is worse than a shorter body.
	const sections = notes.split(SECTION_SEPARATOR)
	const budget = limit - MARKER.length - ASSEMBLY_HEADROOM
	const kept = []
	let size = 0

	for (const section of sections) {
		// +2 accounts for the blank line rejoined with SECTION_SEPARATOR below.
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

module.exports = writeReleaseNotes

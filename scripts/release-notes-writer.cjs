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

const LIMIT = Number(process.env.RELEASE_NOTES_LIMIT || 120000);
const MARKER = '_… earlier changes omitted; see the repository history for the full list._';

/**
 * @param {object} context  semantic-release context
 * @param {object} options  plugin options
 * @returns {string} markdown release body
 */
function writeReleaseNotes(context, options) {
  const opts = options || {};
  const next = context.nextRelease || {};

  if (!next.notes) return '';

  // Under the limit: hand back the generator's own text untouched, so a normal
  // release is byte-identical to what the built-in writer would produce.
  if (next.notes.length <= LIMIT) return next.notes;

  // Over the limit: keep whole sections from the top until the budget is spent.
  // Splitting on a blank line keeps Markdown intact — a slice taken mid-heading
  // emits broken output, which is worse than a shorter body.
  const sections = next.notes.split(/\n{2,}/);
  const kept = [];
  let size = 0;
  const budget = LIMIT - MARKER.length - 200;

  for (const section of sections) {
    const cost = section.length + 2;
    if (size + cost > budget) break;
    kept.push(section);
    size += cost;
  }

  // Always keep at least the first section, even if it alone exceeds the budget:
  // a heading plus a truncated marker beats an empty release body.
  if (kept.length === 0) kept.push(sections[0]);

  const omitted = sections.length - kept.length;
  const elision = omitted > 0 ? `\n\n${MARKER}\n` : '';
  return kept.join('\n\n') + elision;
}

module.exports = writeReleaseNotes;

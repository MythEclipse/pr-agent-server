/**
 * PR-Agent review safety analysis — port of `scripts/pr-queue-worker.py`
 * lines 352-391 (`analyze_review_safety`).
 *
 * The worker will not AI-fix or merge a PR unless the bot's review body says
 * it is safe. This module is that gate: it scores the body and blocks on the
 * two conditions that make a review untrustworthy (a generator error, or a
 * real security / breaking-change finding).
 *
 * THREE REGEX FACTS THIS PORT DOES NOT CHANGE. They are the whole module:
 *
 * 1. THE DOT IS LINE-SCOPED. Neither Python's `.` nor JS's `.` matches a
 *    newline, so every `emoji.*marker` pattern can only see the line the emoji
 *    is on. A security concern mentioned three lines below a clean line is
 *    invisible to the danger pattern. Do not add the `s` flag.
 *
 * 2. THE FLAGS ARE ASYMMETRIC, and that is intentional. The "danger" patterns
 *    are case-insensitive (the bot may write "Security concern" or "security
 *    concerns"); the "clear" patterns are NOT, because their wording is
 *    load-bearing — `No security concerns identified` must match literally, and
 *    lowercasing would also make a negated line match.
 *
 * 3. THE SECURITY PATTERN USES LOOKAROUND, and the lookarounds are
 *    complementary, not decoration: `(?<!No )` refuses to fire on the cleared
 *    line, `(?!s identified)` refuses to fire on the plural of the same clear
 *    phrase. Together they let one alternation reject the clean case without
 *    hardcoding a separate negative list. Both are supported by Bun.
 *
 * The effort pattern is LAZY (`.*?(\d+)`): it takes the FIRST digit on the
 * ⏱️ line, which is the rating, not any number the surrounding prose mentions.
 * The rating is the score knob, so a greedy `.*(\d+)` would read a different
 * number and silently change which PRs count as large.
 */

/** Python's `(safe, reasons, score)` triple, as an object. */
export type SafetyResult = { safe: boolean; reasons: string[]; score: number }

/** Python's starting score (line 355). */
const BASE_SCORE = 5
/** The pass threshold, applied AFTER clamping (Python line 391). */
const SAFE_THRESHOLD = 6

/**
 * Python line 357, verbatim and in order. The first hit wins and short-circuits
 * the whole analysis with score 0 — a body that failed to generate has no
 * meaningful sections to score.
 */
const ERROR_PATTERNS = [
	"Failed to generate",
	"Error during",
	"RetryError",
	"traceback",
	"Internal Server Error",
] as const

/** Python line 361. No flag: the clear phrasing is exact. */
const SEC_CLEAR = /🔒.*No security concerns identified/
/** Python line 362. See fact 3 above. */
const SEC_DANGER = /🔒.*(?<!No )Security concern(?!s identified)/i
/** Python line 370. */
const ISSUES_CLEAR = /⚡.*No major (issues|problems) detected/
/** Python line 371. */
const ISSUES_DANGER = /⚡.*(breaking change|major issue|critical|problem detected)/i
/** Python line 379 — `tests?` is greedy-optional, so "test missing" matches too. */
const TEST_MISSING = /🧪.*(Test required|tests? missing|no tests found)/i
/** Python line 380. Wins over TEST_MISSING: the bot says the tests are irrelevant. */
const TEST_IRRELEVANT = /🧪.*No relevant tests/
/** Python line 384. Lazy — see fact 3. */
const EFFORT = /⏱️.*?(\d+)/

/**
 * Python `analyze_review_safety(body)` (lines 352-391).
 *
 * Scoring is additive and order-sensitive; the early returns are what make a
 * body "unsafe" rather than merely low-scoring, so a security concern and a
 * zero-effort review are different outcomes (one blocks, the other may still
 * pass at score 6).
 */
export function analyzeReviewSafety(body: string): SafetyResult {
	if (!body) return { safe: false, reasons: ["❌ No review"], score: 0 } // line 354

	const reasons: string[] = []
	let score = BASE_SCORE

	for (const pat of ERROR_PATTERNS) {
		// Python re.search with re.IGNORECASE — a bare substring test is NOT
		// equivalent: "Traceback (most recent call last)" must match "traceback".
		if (new RegExp(pat, "i").test(body)) {
			return { safe: false, reasons: [`❌ Review error: ${pat}`], score: 0 }
		}
	}

	if (SEC_CLEAR.test(body)) {
		reasons.push("✅ Security: clean")
		score += 2
	} else if (SEC_DANGER.test(body)) {
		return { safe: false, reasons: ["🔴 Security concern — blocking"], score: 0 }
	} else {
		reasons.push("⚠️ Security unclear")
		score -= 1
	}

	if (ISSUES_CLEAR.test(body)) {
		reasons.push("✅ No major issues")
		score += 2
	} else if (ISSUES_DANGER.test(body)) {
		return { safe: false, reasons: ["🔴 Major issues — blocking"], score: 0 }
	} else {
		reasons.push("⚠️ Issues unclear")
		score -= 1
	}

	// Python lines 379-382: a missing-test warning is suppressed when the body
	// ALSO says the tests are irrelevant, so a lockfile bump is not penalised
	// twice for the same section.
	const testMissing = TEST_MISSING.test(body)
	const testIrrelevant = TEST_IRRELEVANT.test(body)
	if (testMissing && !testIrrelevant) {
		reasons.push("⚠️ Tests missing")
		score -= 1
	}

	// Python lines 384-388. The `else` is not a no-op: a SMALL or absent effort
	// reading is worth +1, so the branch decides the score either way.
	const effort = EFFORT.exec(body)
	const effortRating = effort ? Number(effort[1]) : NaN
	if (effort && effortRating >= 4) {
		reasons.push(`⚠️ Large PR (effort: ${effort[1]})`)
		score -= 1
	} else {
		score += 1
	}

	// Python line 390, then line 391. Clamp BEFORE the comparison: an unclamped
	// 11 would still pass, but the clamp is what makes the reported score
	// comparable to the 0-10 scale the report and Discord messages assume.
	const clamped = Math.max(0, Math.min(10, score))
	return { safe: clamped >= SAFE_THRESHOLD, reasons, score: clamped }
}

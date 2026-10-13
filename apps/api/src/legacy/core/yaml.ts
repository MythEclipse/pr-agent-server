// YAML loading with pr_agent's resilient fallback chain.
// Port of pr_agent.algo.utils.load_yaml + try_fix_yaml using the `yaml` package.

import * as YAML from "yaml"

export function loadYaml(
	responseText: string,
	keysFixYaml: string[] = [],
	firstKey = "",
	lastKey = "",
): Record<string, unknown> | null {
	const original = responseText
	let text = responseText.replace(/^\n+/, "").trim()
	text = text
		.replace(/^yaml/, "")
		.replace(/^```yaml/, "")
		.replace(/\s*$/, "")
		.replace(/```$/, "")

	try {
		const data = YAML.parse(text)
		if (data && typeof data === "object") return data as Record<string, unknown>
	} catch {
		// fall through
	}
	return tryFixYaml(text, keysFixYaml, firstKey, lastKey, original)
}

const KEYS_YAML = [
	"relevant line:",
	"suggestion content:",
	"relevant file:",
	"existing code:",
	"improved code:",
	"label:",
	"why:",
	"suggestion_summary:",
]

/**
 * The column of the most recent top-level `- ` list item, or undefined.
 *
 * A recovered list item must rejoin the sequence it belongs to, and that
 * sequence's own dash column is the only correct answer. Used by fallback 1.6,
 * which splits two items the model collapsed onto one line.
 */
function listDashIndent(lines: string[]): number | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? ""
		const m = /^(\s*)-\s+\S/.exec(line)
		if (m) return (m[1] ?? "").length
	}
	return undefined
}

export function tryFixYaml(
	responseText: string,
	keysFixYaml: string[] = [],
	firstKey = "",
	lastKey = "",
	original = "",
): Record<string, unknown> | null {
	const lines = responseText.split("\n")
	const keysYaml = [...KEYS_YAML, ...keysFixYaml]

	// fallback 1: convert 'key: value' to 'key: |-' multiline
	let copy = lines.map((l) => {
		for (const key of keysYaml) {
			if (l.includes(key) && !l.includes("|")) {
				return l.replace(key, `${key} |\n        `)
			}
		}
		return l
	})
	let data = tryParse(copy.join("\n"))
	if (data) return data

	// 1.5: '|\n' → '|2\n'
	copy = responseText.replace(/\|\n/g, "|2\n").split("\n")
	data = tryParse(copy.join("\n"))
	if (data) return data
	// 1.5b: add 4-space indent to lines at depth 2 containing '}'
	const copyB = copy.map((l) => {
		const initSpace = l.length - l.trimStart().length
		if (initSpace === 2 && !l.includes("|2") && l.includes("}")) {
			return `    ${l.trimStart()}`
		}
		return l
	})
	data = tryParse(copyB.join("\n"))
	if (data) return data

	// fallback 1.5: re-indent block-scalar continuation lines that the model got
	// wrong by one space.
	//
	// Observed live: the models emit
	//
	//     ticket_url: |
	//      dependabot/npm_and_yarn/vite-8.3.4      <-- ONE space
	//       ticket_requirements: |                  <-- six spaces
	//
	// A block scalar's content must be indented MORE than its key. One space is
	// not more than zero, so `YAML.parse` reads the line as a continuation of the
	// scalar and then chokes on the next line's indentation — a hard parse error
	// on structurally valid intent. This is non-deterministic across models and
	// across runs of the same model, which is why it presented as an intermittent
	// "failed to parse review response" rather than a consistent failure.
	//
	// The fix is to derive each block's content indent from the INDENT OF ITS KEY
	// plus a fixed step, rather than from whatever the first content line happens
	// to carry. Reading the baseline off the content line cannot work here: the
	// defective line IS the first content line, so it defines its own baseline and
	// is never repaired. The key's own column is the one thing the model always
	// gets right.
	const reindentBlocks = (src: string): string => {
		const out = src.split("\n")
		const indentOf = (l: string): number => l.length - l.trimStart().length
		// A `key: |` / `key: >` header: the content must sit further right.
		const isHeader = (l: string): boolean => /^\s*[^#\s][^:]*:\s*[|>][-+]?\s*$/.test(l)
		const isKey = (l: string): boolean => /^\s*[^#\s][^:]*:/.test(l)

		let keyIndent = -1
		let blockIndent = -1
		for (let i = 0; i < out.length; i++) {
			const line = out[i] ?? ""
			if (line.trim() === "") continue

			// A key AT the open block's own column, or further left, closes it.
			// This test must come FIRST: a sibling header is indented by exactly
			// the block's content step, so treating headers first would open a new
			// block and leave the previous scalar unterminated — the content line
			// then reads as an implicit key and YAML.parse still throws.
			if (isKey(line) && blockIndent !== -1 && indentOf(line) <= keyIndent) {
				blockIndent = -1
				keyIndent = -1
				continue
			}
			if (isKey(line)) {
				if (isHeader(line)) {
					keyIndent = indentOf(line)
					// Content must be indented MORE than its key, and a sibling key
					// sits exactly `keyIndent + 2`. Using that same column for the
					// content is what left `ticket_requirements` being read as the
					// tail of `ticket_url`'s scalar ("Implicit keys need to be on a
					// single line"). Step past the sibling column.
					blockIndent = keyIndent + 4
				}
				continue
			}

			if (blockIndent === -1) continue

			// Content left of the block's own column is mis-indented by
			// construction; pull it right to that column. Content already at or
			// deeper than it is left exactly as the model wrote it, so this never
			// reindents a well-formed block.
			const indent = indentOf(line)
			if (indent < blockIndent) {
				out[i] = " ".repeat(blockIndent) + line.trimStart()
			}
		}
		return out.join("\n")
	}

	// The structural repairs run on the ORIGINAL text, not on `copy`: fallback 1
	// above rewrites `key: value` into `key: |\n        value`, which destroys the
	// very indentation these repairs read. Applying them to a mangled copy was
	// why they never fired.
	copy = reindentBlocks(responseText).split("\n")
	data = tryParse(copy.join("\n"))
	if (data) return data

	// fallback 1.6: split list items the model emitted onto one line.
	//
	// Observed live: `end_line: 1    - relevant_file: |` — two `- ` items run
	// together, which YAML reads as one scalar and then rejects ("A block
	// sequence may not be used as an implicit map key").
	//
	// The recovered item must land at the SAME column as the list items already
	// in the document, which is the dash column of the enclosing sequence — not
	// the column of the `key: value` it was glued to. Those differ: `end_line`
	// sits one level deeper than the `- ` it belongs to, so using its column
	// produced a sequence nested inside the previous item's mapping.
	copy = copy
		.map((l) => {
			const m = /^(\s*[^#\s][^:]*:\s*(?:\||>|-?\d*)\s*\S.*?)\s{2,}(-\s+\S.*)$/.exec(l)
			if (!m) return l
			return `${m[1]}\n${" ".repeat(listDashIndent(copy) ?? l.length - l.trimStart().length)}${m[2]}`
		})
		.flatMap((l) => l.split("\n"))
	data = tryParse(copy.join("\n"))
	if (data) return data

	// fallback 2: extract yaml fenced block
	//
	// The lookahead used to be `(?=\s*$|")`, which only matches when the closing
	// fence is the END of the text. Modern models append a prose summary after
	// the block ("**Review summary:** …"), so the regex missed, `YAML.parse` was
	// handed prose and threw, and every fallback returned null — the review died
	// as "failed to parse review response into markdown" while the model's YAML
	// was perfectly valid. A fenced block needs no end anchor: the first complete
	// fence pair IS the block, whatever follows it.
	const snippetPattern = /```(?:yaml|yml)?\r?\n([\s\S]*?)```/
	let m = snippetPattern.exec(copy.join("\n"))
	if (!m) m = snippetPattern.exec(original)
	if (m?.[1]) {
		data = tryParse(m[1])
		if (data) return data
	}

	// fallback 3: remove leading/trailing braces
	const t3 = responseText.trim().replace(/^\{/, "").replace(/\}$/, "").replace(/:$/, "")
	data = tryParse(t3)
	if (data) return data

	// fallback 4: extract from first_key to after last_key
	if (firstKey && lastKey) {
		let idxStart = responseText.indexOf(`\n${firstKey}:`)
		if (idxStart === -1) idxStart = responseText.indexOf(`${firstKey}:`)
		const idxLast = responseText.lastIndexOf(`${lastKey}:`)
		let idxEnd = responseText.indexOf("\n\n", idxLast)
		if (idxEnd === -1) idxEnd = responseText.length
		const t4 = responseText
			.slice(idxStart, idxEnd)
			.trim()
			.replace(/^```yaml/, "")
			.replace(/^`/, "")
			.replace(/`$/, "")
		if (t4) {
			data = tryParse(t4)
			if (data) return data
		}
	}

	// fallback 5: remove leading '+'
	copy = lines.map((l) => (l.startsWith("+") ? ` ${l.slice(1)}` : l))
	data = tryParse(copy.join("\n"))
	if (data) return data

	// fallback 6: tabs → spaces
	if (responseText.includes("\t")) {
		data = tryParse(responseText.replace(/\t/g, "    "))
		if (data) return data
	}

	// fallback 7: indent sections for code blocks
	const improveSections = ["existing_code:", "improved_code:", "response:", "why:"]
	const describeSections = ["description:", "title:", "changes_diagram:", "pr_files:", "pr_ticket:"]
	let startLine = -1
	const lines7 = responseText.split("\n").map((l, i) => {
		const strip = l.trimEnd()
		if (
			improveSections.some((k) => strip.includes(k)) ||
			describeSections.some((k) => strip.includes(k))
		) {
			startLine = i
			return l
		} else if (
			strip.endsWith(": |") ||
			strip.endsWith(": |-") ||
			strip.endsWith(": |2") ||
			keysYaml.some((k) => strip.endsWith(k))
		) {
			startLine = -1
			return l
		} else if (startLine !== -1) {
			return `    ${l}`
		}
		return l
	})
	const t7 = lines7.join("\n").replace(/ \|\n/g, " |2\n")
	data = tryParse(t7)
	if (data) return data

	// fallback 8: strip leading pipes
	data = tryParse(responseText.replace(/^\|\n/, ""))
	if (data) return data

	return null
}

function tryParse(text: string): Record<string, unknown> | null {
	try {
		const d = YAML.parse(text)
		if (d && typeof d === "object") return d as Record<string, unknown>
	} catch {
		// ignore
	}
	return null
}

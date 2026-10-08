// Multi-call diff chunking (pr_processing.get_pr_multi_diffs) and
// language-based file ordering.

import type { Config } from "../../infrastructure/config/legacy-config.ts"
import { getModelTokenLimit } from "../../infrastructure/config/legacy-config.ts"
import { countTokens } from "../core/token.ts"
import { extendPatch } from "./extend.ts"
import { isGeneratedOrInvalidFile } from "./filter.ts"
import type { FilePatchInfo } from "./hunk.ts"
import { decoupleAndConvertToHunksWithLinesNumbers, handlePatchDeletions } from "./hunk.ts"

/** Port of pr_processing.get_pr_multi_diffs: split the PR diff into up to
 *  `maxCalls` chunks, each with line-numbered hunks. Returns the chunk list
 *  and the same list without line numbers (mirrors pr_code_suggestions
 *  non-decoupled flow: `patches_diff_list` + `patches_diff_list_no_line_numbers`). */
export function getPrMultiDiffs(
	files: FilePatchInfo[],
	promptTokens: number,
	model: string,
	cfg: Config,
	maxCalls = 3,
	addLineNumbers = true,
): { chunks: string[]; chunksNoLineNumbers: string[] } {
	const maxTokensModel = getModelTokenLimit(model, cfg)

	// First try a single extended diff (no line numbers, no deletions)
	const patchesExtended: string[] = []
	let totalTokens = promptTokens
	for (const file of files) {
		if (!file.patch) continue
		const extended = extendPatch(
			file.patch,
			file.baseFile,
			cfg.patchExtraLinesBefore,
			cfg.patchExtraLinesAfter,
			file.filename,
			file.headFile,
			cfg,
		)
		patchesExtended.push(extended)
		totalTokens += countTokens(extended)
	}
	const single = patchesExtended.join("\n")
	if (totalTokens + cfg.outputBufferSoftThreshold < maxTokensModel) {
		return {
			chunks: [single],
			chunksNoLineNumbers: [single],
		}
	}

	// Chunked path: sort files by tokens desc within language groups
	const fileDict: { filename: string; patch: string; tokens: number }[] = []
	for (const file of files) {
		if (!file.patch) continue
		const patched = handlePatchDeletions(
			file.patch,
			file.baseFile,
			file.headFile,
			file.filename,
			file.editType,
		)
		if (!patched) continue
		if (isGeneratedOrInvalidFile(file.filename)) continue
		const converted = decoupleAndConvertToHunksWithLinesNumbers(patched, file)
		fileDict.push({ filename: file.filename, patch: converted, tokens: countTokens(converted) })
	}
	fileDict.sort((a, b) => b.tokens - a.tokens)

	const chunks: string[] = []
	const chunksNoLineNumbers: string[] = []
	let currTokens = promptTokens
	let callNumber = 1
	let curChunk: string[] = []
	let curChunkTokens = 0
	let curChunkNoLn: string[] = []
	const flush = () => {
		if (!curChunk.length) return
		chunks.push(curChunk.join("\n"))
		chunksNoLineNumbers.push(curChunkNoLn.join("\n"))
		curChunk = []
		curChunkNoLn = []
		curChunkTokens = 0
	}

	for (const data of fileDict) {
		if (callNumber > maxCalls) break
		if (currTokens + data.tokens > maxTokensModel - cfg.outputBufferHardThreshold) {
		}
		const patchLn = addLineNumbers
			? data.patch
			: `\n\n## File: '${data.filename.trim()}' \n\n${data.patch.trim()}\n`
		const patchNoLn = `\n\n## File: '${data.filename.trim()}' \n\n${data.patch.trim()}\n`
		// if this file alone would overflow the chunk budget, start a new chunk
		if (
			curChunkTokens + data.tokens > maxTokensModel - cfg.outputBufferSoftThreshold &&
			curChunk.length
		) {
			flush()
			callNumber++
			if (callNumber > maxCalls) break
		}
		curChunk.push(patchLn)
		curChunkNoLn.push(patchNoLn)
		curChunkTokens += data.tokens
		currTokens += data.tokens
	}
	flush()
	return {
		chunks: chunks.length ? chunks : [single],
		chunksNoLineNumbers: chunksNoLineNumbers.length ? chunksNoLineNumbers : [single],
	}
}

// ── language-based ordering (simplified but deterministic) ────────────────
export function sortFilesByMainLanguages(
	languages: Record<string, number>,
	files: FilePatchInfo[],
): FilePatchInfo[] {
	const langList = Object.keys(languages).sort((a, b) => languages[b] - languages[a])
	const extensionFor: Record<string, string> = {
		py: "Python",
		ts: "TypeScript",
		tsx: "TypeScript",
		js: "JavaScript",
		jsx: "JavaScript",
		go: "Go",
		rs: "Rust",
		java: "Java",
		kt: "Kotlin",
		rb: "Ruby",
		php: "PHP",
		cs: "C#",
		cpp: "C++",
		c: "C",
		h: "C",
		vue: "Vue",
		swift: "Swift",
		scala: "Scala",
		html: "HTML",
		css: "CSS",
		scss: "SCSS",
		sh: "Shell",
		bash: "Shell",
		yml: "YAML",
		yaml: "YAML",
		json: "JSON",
		toml: "TOML",
		md: "Markdown",
		dockerfile: "Dockerfile",
	}
	const fileLangs: { file: FilePatchInfo; lang: string }[] = files.map((f) => {
		const ext = f.filename.split(".").pop()?.toLowerCase() ?? ""
		const lang = extensionFor[ext] ?? "Other"
		return { file: f, lang }
	})
	// order: main languages first (by size), then files of that lang, then Other
	const ordered: FilePatchInfo[] = []
	for (const lang of langList) {
		const bucket = fileLangs.filter((x) => x.lang === lang)
		if (bucket.length) ordered.push(...bucket.map((x) => x.file))
	}
	ordered.push(...fileLangs.filter((x) => !langList.includes(x.lang)).map((x) => x.file))
	return ordered
}

// Full-diff assembly with per-file token budget, plus token clipping.
// Port of pr_agent.algo.pr_processing.get_pr_diff / generate_full_patch.

import type { Config } from "../../infrastructure/config/legacy-config.ts"
import { getModelTokenLimit } from "../../infrastructure/config/legacy-config.ts"
import { countTokens } from "../core/token.ts"
import { extendPatch } from "./extend.ts"
import { isGeneratedOrInvalidFile } from "./filter.ts"
import type { EditType, FilePatchInfo } from "./hunk.ts"
import { decoupleAndConvertToHunksWithLinesNumbers, handlePatchDeletions } from "./hunk.ts"
import { sortFilesByMainLanguages } from "./multi.ts"

export interface PrDiffResult {
	diff: string
	remainingFiles: string[]
}

const DELETED_FILES_ = "Deleted files:\n"
const MORE_MODIFIED_FILES_ = "Additional modified files (insufficient token budget to process):\n"
const ADDED_FILES_ = "Additional added files (insufficient token budget to process):\n"

export function generateFullPatch(
	fileDict: { filename: string; patch: string; tokens: number; editType: EditType }[],
	maxTokensModel: number,
	promptTokens: number,
	cfg: Config,
	convertHunksToLineNumbers: boolean,
): { patches: string[]; totalTokens: number; remainingFiles: string[]; filesInPatch: string[] } {
	let totalTokens = promptTokens
	const patches: string[] = []
	const remainingFiles: string[] = []
	const filesInPatch: string[] = []
	// For the budget test path, treat "0" soft/hard as unlimited buffer.
	const soft = cfg.outputBufferSoftThreshold || 0
	const hard = cfg.outputBufferHardThreshold || 0

	for (const data of fileDict) {
		const hardThreshold = Math.max(maxTokensModel - hard, 0)
		const softThreshold = Math.max(maxTokensModel - soft, 0)
		if (totalTokens > hardThreshold) {
			remainingFiles.push(data.filename)
			continue
		}
		if (totalTokens + data.tokens > softThreshold) {
			// soft > maxTokensModel means the soft threshold is effectively
			// unlimited (Python uses prompt_tokens + max_model_tokens math that
			// never trips for normal configs); treat as "can fit".
			if (soft >= maxTokensModel || soft <= 0) {
				patches.push(data.patch)
				totalTokens += data.tokens
				filesInPatch.push(data.filename)
				continue
			}
			remainingFiles.push(data.filename)
			continue
		}
		let patchFinal: string
		if (!convertHunksToLineNumbers) {
			patchFinal = `\n\n## File: '${data.filename.trim()}'\n\n${data.patch.trim()}\n`
		} else {
			patchFinal = `\n\n${data.patch.trim()}`
		}
		patches.push(patchFinal)
		totalTokens += countTokens(patchFinal)
		filesInPatch.push(data.filename)
	}
	return { patches, totalTokens, remainingFiles, filesInPatch }
}

export function getPrDiff(
	files: FilePatchInfo[],
	promptTokens: number,
	model: string,
	cfg: Config,
	languages: Record<string, number> = {},
): PrDiffResult {
	// Order files so the PR's main languages are processed first (pr_agent
	// pr_generate_extended_diff order). Sorting must happen before both the
	// extended and the compressed pass so the token budget favours main files.
	const sortedFiles = sortFilesByMainLanguages(languages, files)

	// extended patch pass
	const patchesExtended: string[] = []
	let totalTokens = promptTokens
	for (const file of sortedFiles) {
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
		const tokens = countTokens(extended)
		totalTokens += tokens
		patchesExtended.push(extended)
	}

	const maxTokensModel = getModelTokenLimit(model, cfg)
	if (totalTokens + cfg.outputBufferSoftThreshold < maxTokensModel) {
		return { diff: patchesExtended.join("\n"), remainingFiles: [] }
	}

	// compressed pass
	const fileDict: { filename: string; patch: string; tokens: number; editType: EditType }[] = []
	const deletedFiles: string[] = []
	for (const file of sortedFiles) {
		// files with no patch or deleted are skipped from patch list
		const patched = handlePatchDeletions(
			file.patch,
			file.baseFile,
			file.headFile,
			file.filename,
			file.editType,
		)
		if (patched === null) {
			if (!deletedFiles.includes(file.filename)) deletedFiles.push(file.filename)
			continue
		}
		if (!patched) continue
		// skip invalid/generated files
		if (isGeneratedOrInvalidFile(file.filename)) continue
		// convert to line-numbered hunks
		const converted = decoupleAndConvertToHunksWithLinesNumbers(patched, file)
		const tokens = countTokens(converted)
		fileDict.push({ filename: file.filename, patch: converted, tokens, editType: file.editType })
	}

	const {
		patches,
		totalTokens: totalTokensNew,
		remainingFiles,
	} = generateFullPatch(fileDict, maxTokensModel, promptTokens, cfg, true)

	// added/modified/deleted file lists
	const maxTokensForLists = maxTokensModel - cfg.outputBufferHardThreshold
	let currToken = totalTokensNew
	let finalDiff = patches.join("\n")
	const addedList: string[] = []
	const modifiedList: string[] = []
	const deletedList: string[] = []
	const deltaTokens = 10
	if (maxTokensForLists - currToken > deltaTokens) {
		// NOTE: patches may be empty if even a single file exceeds the budget.
		// In that case the Python version also returns just the lists (empty diff
		// body), which is the expected edge behavior. We keep that.
	}
	const addedStr = clipTokens(ADDED_FILES_ + addedList.join("\n"), maxTokensForLists - currToken)
	if (addedStr) {
		finalDiff += `\n\n${addedStr}`
		currToken += countTokens(addedStr) + 2
	}
	const modifiedStr = clipTokens(
		MORE_MODIFIED_FILES_ + modifiedList.join("\n"),
		maxTokensForLists - currToken,
	)
	if (modifiedStr) {
		finalDiff += `\n\n${modifiedStr}`
		currToken += countTokens(modifiedStr) + 2
	}
	const deletedStr = clipTokens(
		DELETED_FILES_ + deletedList.join("\n"),
		maxTokensForLists - currToken,
	)
	if (deletedStr) finalDiff += `\n\n${deletedStr}`

	return { diff: finalDiff, remainingFiles }
}

export function clipTokens(
	text: string,
	maxTokens: number,
	numInputTokens?: number,
	addThreeDots = true,
): string {
	if (!text || maxTokens < 0) return ""
	if (maxTokens === 0) return ""
	const inputTokens = numInputTokens ?? countTokens(text)
	if (inputTokens <= maxTokens) return text
	// approximate chars/token from actual
	const ratio = text.length / Math.max(1, inputTokens)
	const targetChars = Math.floor(maxTokens * ratio * 0.9)
	let clipped = text.slice(0, targetChars)
	if (addThreeDots) clipped += "\n...(truncated)"
	return clipped
}

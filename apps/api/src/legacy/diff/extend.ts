// Patch extension — adds surrounding context lines to a patch, with optional
// dynamic-context trimming. Port of pr_agent.algo.git_patch_processing.extend_patch.

import type { Config } from "../../infrastructure/config/legacy-config.ts"
import { shouldSkipPatch } from "./filter.ts"
import { parseHunkHeader } from "./hunk.ts"

const MAX_EXTRA_LINES = 10

export function extendPatch(
	patchStr: string,
	originalFileStr: string,
	patchExtraLinesBefore: number,
	patchExtraLinesAfter: number,
	filename: string,
	newFileStr = "",
	cfg?: Config,
): string {
	if (
		!patchStr ||
		(patchExtraLinesBefore === 0 && patchExtraLinesAfter === 0) ||
		!originalFileStr
	) {
		return patchStr
	}
	if (shouldSkipPatch(filename, cfg)) return patchStr

	const allowDynamicContext = cfg?.allowDynamicContext ?? true
	const maxDynamicBefore = cfg?.maxExtraLinesBeforeDynamicContext ?? 10
	const patchExtraBeforeDynamic =
		maxDynamicBefore > MAX_EXTRA_LINES ? MAX_EXTRA_LINES : maxDynamicBefore

	const fileOriginalLines = originalFileStr.split("\n")
	const fileNewLines = newFileStr ? newFileStr.split("\n") : []
	const lenOriginalLines = fileOriginalLines.length
	const patchLines = patchStr.split("\n")
	const extendedPatchLines: string[] = []

	let isValidHunk = true
	let start1 = -1,
		size1 = -1,
		start2 = -1,
		size2 = -1

	for (let i = 0; i < patchLines.length; i++) {
		const line = patchLines[i]
		if (line.startsWith("@@")) {
			const match = parseHunkHeader(line)
			if (match) {
				// finish previous hunk
				if (isValidHunk && start1 !== -1 && patchExtraLinesAfter > 0) {
					const slice = fileOriginalLines.slice(
						start1 + size1 - 1,
						start1 + size1 - 1 + patchExtraLinesAfter,
					)
					extendedPatchLines.push(...slice.map((l) => ` ${l}`))
				}
				let sectionHeader = match.sectionHeader
				start1 = match.start1
				size1 = match.size1
				start2 = match.start2
				size2 = match.size2

				isValidHunk = checkHunkLinesMatch(i, fileOriginalLines, patchLines, start1)

				if (isValidHunk && (patchExtraLinesBefore > 0 || patchExtraLinesAfter > 0)) {
					const calcContextLimits = (before: number) => {
						const extStart1 = Math.max(1, start1 - before)
						let extSize1 = size1 + (start1 - extStart1) + patchExtraLinesAfter
						const extStart2 = Math.max(1, start2 - before)
						let extSize2 = size2 + (start2 - extStart2) + patchExtraLinesAfter
						if (extStart1 - 1 + extSize1 > lenOriginalLines) {
							const deltaCap = extStart1 - 1 + extSize1 - lenOriginalLines
							extSize1 = Math.max(extSize1 - deltaCap, size1)
							extSize2 = Math.max(extSize2 - deltaCap, size2)
						}
						return { extStart1, extSize1, extStart2, extSize2 }
					}

					let limits = calcContextLimits(patchExtraLinesBefore)
					if (allowDynamicContext && fileNewLines.length) {
						limits = calcContextLimits(patchExtraBeforeDynamic)
						const linesBeforeOriginal = fileOriginalLines.slice(limits.extStart1 - 1, start1 - 1)
						const linesBeforeNew = fileNewLines.slice(limits.extStart2 - 1, start2 - 1)
						let foundHeader = false
						if (sectionHeader) {
							for (let j = 0; j < linesBeforeOriginal.length; j++) {
								if (linesBeforeOriginal[j].includes(sectionHeader)) {
									limits.extStart1 += j
									limits.extStart2 += j
									limits.extSize1 -= j
									limits.extSize2 -= j
									const dynOrig = linesBeforeOriginal.slice(j)
									const dynNew = linesBeforeNew.slice(j)
									if (arraysEqual(dynOrig, dynNew)) {
										foundHeader = true
										sectionHeader = ""
									}
									break
								}
							}
						}
						if (!foundHeader) limits = calcContextLimits(patchExtraLinesBefore)
					}

					let deltaLinesOriginal = fileOriginalLines
						.slice(limits.extStart1 - 1, start1 - 1)
						.map((l) => ` ${l}`)
					if (fileNewLines.length) {
						let deltaLinesNew = fileNewLines
							.slice(limits.extStart2 - 1, start2 - 1)
							.map((l) => ` ${l}`)
						if (!arraysEqual(deltaLinesOriginal, deltaLinesNew)) {
							let foundMiniMatch = false
							for (let k = 0; k < deltaLinesOriginal.length; k++) {
								if (arraysEqual(deltaLinesOriginal.slice(k), deltaLinesNew.slice(k))) {
									deltaLinesOriginal = deltaLinesOriginal.slice(k)
									deltaLinesNew = deltaLinesNew.slice(k)
									limits.extStart1 += k
									limits.extSize1 -= k
									limits.extStart2 += k
									limits.extSize2 -= k
									foundMiniMatch = true
									break
								}
							}
							if (!foundMiniMatch) {
								limits = {
									extStart1: start1,
									extSize1: size1,
									extStart2: start2,
									extSize2: size2,
								}
								deltaLinesOriginal = []
							}
						}
					}

					if (sectionHeader && !allowDynamicContext) {
						for (const l of deltaLinesOriginal) {
							if (l.includes(sectionHeader)) {
								sectionHeader = ""
								break
							}
						}
					}
					extendedPatchLines.push(
						`@@ -${limits.extStart1},${limits.extSize1} +${limits.extStart2},${limits.extSize2} @@ ${sectionHeader}`,
					)
					extendedPatchLines.push(...deltaLinesOriginal)
					continue
				} else {
					extendedPatchLines.push(`@@ -${start1},${size1} +${start2},${size2} @@ ${sectionHeader}`)
					continue
				}
			}
		}
		extendedPatchLines.push(line)
	}

	if (start1 !== -1 && patchExtraLinesAfter > 0 && isValidHunk) {
		const delta = fileOriginalLines.slice(
			start1 + size1 - 1,
			start1 + size1 - 1 + patchExtraLinesAfter,
		)
		extendedPatchLines.push(...delta.map((l) => ` ${l}`))
	}

	return extendedPatchLines.join("\n")
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
	return true
}

function checkHunkLinesMatch(
	i: number,
	originalLines: string[],
	patchLines: string[],
	start1: number,
): boolean {
	try {
		if (i + 1 < patchLines.length && patchLines[i + 1][0] === " ") {
			if (patchLines[i + 1].trim() !== (originalLines[start1 - 1] ?? "").trim()) {
				return false
			}
		}
	} catch {
		// ignore
	}
	return true
}

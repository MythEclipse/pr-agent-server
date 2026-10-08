// Hunk parsing and patch-to-line-numbered-hunk conversion.
// Port of pr_agent.algo.git_patch_processing hunk helpers.

export enum EditType {
	ADDED = "added",
	DELETED = "deleted",
	MODIFIED = "modified",
	RENAMED = "renamed",
	UNKNOWN = "unknown",
}

export interface FilePatchInfo {
	filename: string
	baseFile: string
	headFile: string
	patch: string
	editType: EditType
	numPlusLines: number
	numMinusLines: number
}

// Same regex as Python: ^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ ]?(.*)
const RE_HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ ]?(.*)/

interface HunkHeader {
	start1: number
	size1: number
	start2: number
	size2: number
	sectionHeader: string
}

export function parseHunkHeader(line: string): HunkHeader | null {
	const m = RE_HUNK_HEADER.exec(line)
	if (!m) return null
	return {
		start1: m[1] ? parseInt(m[1], 10) : 0,
		size1: m[2] ? parseInt(m[2], 10) : 1,
		start2: m[3] ? parseInt(m[3], 10) : 0,
		size2: m[4] ? parseInt(m[4], 10) : 1,
		sectionHeader: m[5] || "",
	}
}

export function omitDeletionHunks(patch: string): string {
	const lines = patch.split("\n")
	const addedPatched: string[] = []
	let tempHunk: string[] = []
	let addHunk = false
	let insideHunk = false

	for (const line of lines) {
		if (line.startsWith("@@")) {
			if (parseHunkHeader(line)) {
				if (insideHunk) {
					if (addHunk) addedPatched.push(...tempHunk)
					tempHunk = []
					addHunk = false
				}
				tempHunk.push(line)
				insideHunk = true
			}
		} else {
			tempHunk.push(line)
			if (line) {
				if (line[0] === "+") addHunk = true
			}
		}
	}
	if (insideHunk && addHunk) addedPatched.push(...tempHunk)
	return addedPatched.join("\n")
}

export function handlePatchDeletions(
	patch: string,
	_originalFile: string,
	newFile: string,
	_filename: string,
	editType: EditType,
): string | null {
	if (!newFile && (editType === EditType.DELETED || editType === EditType.UNKNOWN)) {
		return null // deleted file → no patch
	}
	const patchNew = omitDeletionHunks(patch)
	return patchNew
}

export function decoupleAndConvertToHunksWithLinesNumbers(
	patch: string,
	file: FilePatchInfo | null,
): string {
	let out = ""
	if (file) {
		if (file.editType === EditType.DELETED) {
			return `\n\n## File '${file.filename.trim()}' was deleted\n`
		}
		out = `\n\n## File: '${file.filename.trim()}'\n`
	}

	const patchLines = patch.split("\n")
	let newContentLines: string[] = []
	let oldContentLines: string[] = []
	let match: HunkHeader | null = null
	let start2 = -1
	let prevHeaderLine = ""
	let headerLine = ""

	function flushHunk(isLast = false) {
		if (match && (newContentLines.length || oldContentLines.length)) {
			if (!isLast) out += `\n${prevHeaderLine}\n`
			const isPlus = newContentLines.some((l) => l.startsWith("+"))
			const isMinus = oldContentLines.some((l) => l.startsWith("-"))
			if (isPlus || isMinus) {
				out = out.replace(/\s*$/, "") + "\n__new hunk__\n"
				for (let i = 0; i < newContentLines.length; i++) {
					out += `${start2 + i} ${newContentLines[i]}\n`
				}
			}
			if (isMinus) {
				out = out.replace(/\s*$/, "") + "\n__old hunk__\n"
				for (const l of oldContentLines) out += `${l}\n`
			}
			newContentLines = []
			oldContentLines = []
		}
	}

	for (let lineI = 0; lineI < patchLines.length; lineI++) {
		const line = patchLines[lineI]
		if (line.toLowerCase().includes("no newline at end of file")) continue

		if (line.startsWith("@@")) {
			headerLine = line
			const m = parseHunkHeader(line)
			if (m && (newContentLines.length || oldContentLines.length)) {
				flushHunk()
			}
			if (m) {
				prevHeaderLine = headerLine
				start2 = m.start2
			}
			match = m
		} else if (line.startsWith("+")) {
			newContentLines.push(line)
		} else if (line.startsWith("-")) {
			oldContentLines.push(line)
		} else {
			if (!line && lineI) {
				if (lineI + 1 < patchLines.length && patchLines[lineI + 1].startsWith("@@")) continue
				if (lineI + 1 === patchLines.length) continue
			}
			newContentLines.push(line)
			oldContentLines.push(line)
		}
	}
	flushHunk(true)

	return out.trimEnd()
}

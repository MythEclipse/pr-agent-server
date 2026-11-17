// Pagination of the GitHub list endpoints the review prompt is built from.
//
// THE BUG THIS PINS: `pulls.listFiles({ per_page: 100 })` returns ONE page.
// A PR with 101 changed files was reviewed from 100 of them, with no error and
// no notice — the review was published as if it had covered the whole diff.
// The same one-page read applied to issue comments (where the persistent
// review's location matters) and to commits (whose messages are part of the
// prompt).
//
// The provider is built from its prototype, like `github-auth.test.ts` does,
// because the constructor creates an App-auth Octokit. Only the members under
// test are stubbed.

import { describe, expect, test } from "vitest"
import { GitHubProvider } from "../src/infrastructure/github/provider.ts"

// biome-ignore lint/suspicious/noExplicitAny: prototype stubs stand in for Octokit
type AnyProvider = any

const HEAD = "a".repeat(40)

/** A provider with auth, retry and PR metadata stubbed out. */
function stubProvider(octokit: AnyProvider): AnyProvider {
	const provider: AnyProvider = Object.create(GitHubProvider.prototype)
	provider.repo = "o/r"
	provider.prNumber = 7
	provider.diffs = null
	provider.ensureToken = async () => {}
	// `retry` is the real method's contract (call it, return its value); the
	// backoff behaviour is not what this test is about.
	provider.retry = async (fn: () => Promise<unknown>) => fn()
	provider.getPr = async () => ({ head: { sha: HEAD, ref: "f" }, base: { sha: "base" } })
	provider.getMergeBaseSha = async () => "base"
	provider.getRepoFileContent = async () => ""
	provider.octokit = octokit
	return provider
}

/** A changed-file payload with a patch, so no base/head read is needed. */
const file = (n: number) => ({
	filename: `src/file-${n}.ts`,
	status: "modified",
	patch: "@@ -1 +1 @@\n-old\n+new",
	additions: 1,
	deletions: 1,
})

const pageOf = (from: number, count: number) =>
	Array.from({ length: count }, (_, i) => file(from + i))

describe("getDiffFiles pagination", () => {
	test("walks past 100 files instead of silently truncating the diff", async () => {
		const pages: number[] = []
		const provider = stubProvider({
			pulls: {
				listFiles: async ({ page }: { page: number }) => {
					pages.push(page)
					return { data: page === 1 ? pageOf(1, 100) : pageOf(101, 2) }
				},
			},
		})

		const files = await provider.getDiffFiles()

		expect(files).toHaveLength(102)
		expect(files.at(-1).filename).toBe("src/file-102.ts")
		expect(pages).toEqual([1, 2])
	})

	test("stops after a short page — one request when the PR is small", async () => {
		const pages: number[] = []
		const provider = stubProvider({
			pulls: {
				listFiles: async ({ page }: { page: number }) => {
					pages.push(page)
					return { data: pageOf(1, 3) }
				},
			},
		})

		expect(await provider.getDiffFiles()).toHaveLength(3)
		expect(pages).toEqual([1])
	})

	test("a full page followed by an EMPTY page ends the walk", async () => {
		// GitHub answers a page past the end with `[]`, not with an error. Without
		// this the loop would either stop at 100 or never stop.
		const pages: number[] = []
		const provider = stubProvider({
			pulls: {
				listFiles: async ({ page }: { page: number }) => {
					pages.push(page)
					return { data: page === 1 ? pageOf(1, 100) : [] }
				},
			},
		})

		expect(await provider.getDiffFiles()).toHaveLength(100)
		expect(pages).toEqual([1, 2])
	})
})

describe("listIssueComments pagination", () => {
	test("reads every page, so a review comment past the first page is found", async () => {
		const pages: number[] = []
		const comment = (id: number) => ({
			id,
			body: `comment ${id}`,
			performed_via_github_app: { id: 4319749 },
			html_url: `https://gh/${id}`,
			created_at: "",
		})
		const provider = stubProvider({
			issues: {
				listComments: async ({ page }: { page: number }) => {
					pages.push(page)
					return {
						data:
							page === 1 ? Array.from({ length: 100 }, (_, i) => comment(i + 1)) : [comment(101)],
					}
				},
			},
		})

		const comments = await provider.listIssueComments()

		expect(comments).toHaveLength(101)
		expect(comments.at(-1).id).toBe(101)
		expect(comments.at(-1).appId).toBe(4319749)
		expect(pages).toEqual([1, 2])
	})
})

describe("getLabels pagination", () => {
	test("reads every page — a label past the first page is not reported as absent", async () => {
		const pages: number[] = []
		const provider = stubProvider({
			issues: {
				listLabelsOnIssue: async ({ page }: { page: number }) => {
					pages.push(page)
					return {
						data:
							page === 1
								? Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }))
								: [{ name: "pr-agent: skip" }],
					}
				},
			},
		})

		const labels = await provider.getLabels()

		expect(labels).toHaveLength(101)
		expect(labels).toContain("pr-agent: skip")
		expect(pages).toEqual([1, 2])
	})
})

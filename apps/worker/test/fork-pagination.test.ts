import { describe, expect, test } from "vitest"
import type { GhAppClient } from "../src/pr/scan.ts"
import { listForkRepos, syncOpenPr } from "../src/sync/repos.ts"

const next = '<https://api.github.com/resource?page=2>; rel="next"'
const pageOf = (path: string) => Number(new URL(`http://x${path}`).searchParams.get("page"))

describe("fork discovery pagination", () => {
	test("finds the fork in a repository page under the second installation", async () => {
		const calls: string[] = []
		const api: GhAppClient = {
			installationToken: async (id) => `token-${id}`,
			request: async (_m, path, opts) => {
				calls.push(path)
				if (path.startsWith("/app/installations"))
					return { status: 200, data: [{ id: pageOf(path) }], link: pageOf(path) === 1 ? next : "" }
				if (path.startsWith("/installation/repositories")) {
					if (opts?.token === "token-1")
						return { status: 200, data: { total_count: 0, repositories: [] } }
					return {
						status: 200,
						data: {
							total_count: 101,
							repositories:
								pageOf(path) === 1
									? Array.from({ length: 100 }, (_, i) => ({
											full_name: `o/plain-${i}`,
											fork: false,
										}))
									: [{ full_name: "o/last-fork", fork: true }],
						},
					}
				}
				return { status: 200, data: { default_branch: "main", parent: { full_name: "up/source" } } }
			},
		}
		expect(await listForkRepos(api)).toEqual([["token-2", "o/last-fork", "up/source", "main"]])
		expect(calls).toContain("/installation/repositories?per_page=100&page=2")
	})

	test("follows a repository next link even when a page is short and has no total", async () => {
		const api: GhAppClient = {
			installationToken: async () => "token",
			request: async (_m, path) => {
				if (path.startsWith("/app/installations")) return { status: 200, data: [{ id: 1 }] }
				if (path.startsWith("/installation/repositories"))
					return {
						status: 200,
						data: { repositories: [{ full_name: `o/f${pageOf(path)}`, fork: true }] },
						link: pageOf(path) === 1 ? next : "",
					}
				return { status: 200, data: { parent: { full_name: "up/x" } } }
			},
		}
		expect((await listForkRepos(api)).map((f) => f[1])).toEqual(["o/f1", "o/f2"])
	})
})

describe("sync PR pagination", () => {
	const unrelated = { number: 1, head: { ref: "feature" }, base: { ref: "main" } }
	test("finds the matching sync PR after fifty unrelated PRs", async () => {
		const api: GhAppClient = {
			installationToken: async () => "",
			request: async (_m, path) => ({
				status: 200,
				data:
					pageOf(path) === 1
						? Array(50).fill(unrelated)
						: [{ number: 51, head: { ref: "upstream-sync-2026" }, base: { ref: "main" } }],
			}),
		}
		expect(await syncOpenPr(api, "token", "o/f", "main")).toBe(51)
	})

	test("a short page with a next link still continues; wrong base is ignored", async () => {
		const api: GhAppClient = {
			installationToken: async () => "",
			request: async (_m, path) => ({
				status: 200,
				data: [
					{
						number: pageOf(path),
						head: { ref: "upstream-sync-2026" },
						base: { ref: pageOf(path) === 1 ? "release" : "main" },
					},
				],
				link: pageOf(path) === 1 ? next : "",
			}),
		}
		expect(await syncOpenPr(api, "token", "o/f", "main")).toBe(2)
	})

	test("an unreadable second page cannot authorize a duplicate PR", async () => {
		const api: GhAppClient = {
			installationToken: async () => "",
			request: async (_m, path) =>
				pageOf(path) === 1
					? { status: 200, data: Array(50).fill(unrelated) }
					: { status: 503, data: {} },
		}
		await expect(syncOpenPr(api, "token", "o/f", "main")).rejects.toThrow("Cannot confirm")
	})
})

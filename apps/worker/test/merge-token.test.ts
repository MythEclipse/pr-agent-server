// The merge token decides whether the deploy ever runs.
//
// A merge made with an App installation token does NOT fire the resulting
// `push` event — GitHub suppresses workflow runs for pushes made by the App's
// own token, so the commit lands on main and every `on: push` workflow (which
// in this fleet is every deploy.yml) silently never runs. The merge reports
// success and nothing ships.
//
// These tests pin the token CHOICE, because the symptom of getting it wrong is
// invisible: a green merge with no deploy.
import { describe, expect, test } from "vitest"
import { mergePr } from "../src/pr/merge.ts"

type Call = { method: string; path: string; token?: string; json?: unknown }

/** Records every request and answers from a per-call queue of statuses. */
function fakeApi(statuses: number[]) {
	const calls: Call[] = []
	let i = 0
	const api = {
		request: async (
			method: string,
			path: string,
			opts: { token?: string; json?: unknown } = {},
		) => {
			calls.push({ method, path, token: opts.token, json: opts.json })
			const status = statuses[Math.min(i, statuses.length - 1)]
			i++
			return { status, data: status === 200 ? { sha: "merged" } : {} }
		},
	}
	return { api, calls }
}

const deps = (pat: string) => ({ fetchGhToken: () => pat })

describe("mergePr — token choice", () => {
	test("uses the PAT FIRST so the merge fires `push` and the deploy runs", async () => {
		const { api, calls } = fakeApi([200])
		const r = await mergePr(deps("pat-token"), api as never, "app-token", "o/r", 7, "abc")

		expect(r.status).toBe(200)
		expect(calls).toHaveLength(1)
		// The point of the whole change: the App token must not be the one used
		// when a PAT is available.
		expect(calls[0].token).toBe("pat-token")
	})

	test("falls back to the App token when the PAT is unauthorised", async () => {
		const { api, calls } = fakeApi([403, 200])
		const r = await mergePr(deps("weak-pat"), api as never, "app-token", "o/r", 7, "abc")

		expect(r.status).toBe(200)
		expect(calls.map((c) => c.token)).toEqual(["weak-pat", "app-token"])
	})

	test("treats 401 the same as 403 — both mean 'try the App'", async () => {
		const { api, calls } = fakeApi([401, 200])
		const r = await mergePr(deps("expired-pat"), api as never, "app-token", "o/r", 7, "abc")

		expect(r.status).toBe(200)
		expect(calls.map((c) => c.token)).toEqual(["expired-pat", "app-token"])
	})

	test("does NOT retry the PAT a second time when the App also gets 403", async () => {
		// Regression: an earlier draft tried the PAT, fell through on 403, then the
		// old 403-retry branch tried the SAME failing PAT again.
		const { api, calls } = fakeApi([403, 403])
		const r = await mergePr(deps("weak-pat"), api as never, "app-token", "o/r", 7, "abc")

		expect(r.status).toBe(403)
		expect(calls.map((c) => c.token)).toEqual(["weak-pat", "app-token"])
	})

	test("returns a definitive answer from the PAT without consulting the App", async () => {
		// 405 (not mergeable) and 409 (head moved) are the same for both tokens, so
		// asking twice would only double the API calls.
		for (const status of [405, 409]) {
			const { api, calls } = fakeApi([status])
			const r = await mergePr(deps("pat"), api as never, "app-token", "o/r", 7, "abc")
			expect(r.status).toBe(status)
			expect(calls).toHaveLength(1)
		}
	})

	test("uses the App token directly when no PAT exists", async () => {
		const { api, calls } = fakeApi([200])
		const r = await mergePr(deps(""), api as never, "app-token", "o/r", 7, "abc")

		expect(r.status).toBe(200)
		expect(calls).toHaveLength(1)
		expect(calls[0].token).toBe("app-token")
	})

	test("sends the head sha as a pre-merge condition", async () => {
		const { api, calls } = fakeApi([200])
		await mergePr(deps("pat"), api as never, "app-token", "o/r", 7, "deadbeef")

		expect(calls[0].json).toMatchObject({ merge_method: "merge", sha: "deadbeef" })
	})
})

// Auth/regression tests for the github/ split (Task 3).
//  - buildAuthHook: S10 — the installation-token hook must inject the header
//    synchronously from a cached token, never fire an unauthenticated request.
//  - publishPersistentComment: S9 — the updated comment must always carry the
//    freshly rendered header.
//  - AppAuthClient: installation token cached with expiresAt, refreshed <60s early.

import { describe, expect, test } from "vitest"
import { AppAuthClient, buildAuthHook } from "../src/infrastructure/github/client.ts"
import { type GhComment, GitHubProvider } from "../src/infrastructure/github/index.ts"

describe("installation token auth hook", () => {
	test("injects Bearer header synchronously from a cached token", () => {
		const seen: Record<string, string> = {}
		const hook = buildAuthHook(() => "tok_123")
		hook(
			(opts: { headers: Record<string, string> }) => {
				Object.assign(seen, opts.headers)
				return Promise.resolve("ok")
			},
			{ headers: {} },
		)
		expect(seen.authorization).toBe("Bearer tok_123")
	})

	test("never sends a request without an authorization header", async () => {
		const calls: { headers: Record<string, string> }[] = []
		const hook = buildAuthHook(() => "tok_456")
		await hook(
			(opts: { headers: Record<string, string> }) => {
				calls.push(opts)
				return Promise.resolve("ok")
			},
			{ headers: {} },
		)
		expect(calls.length).toBe(1)
		expect(calls[0].headers.authorization).toBe("Bearer tok_456")
	})
})

// ── S9: persistent comment header ──────────────────────────────────────────

const INITIAL_HEADER = "## PR Reviewer Guide 🔍"
const COMMIT_URL = "https://github.com/o/r/commit/abc123"
const UPDATED_HEADER_NOTE = `#### (Review updated until commit ${COMMIT_URL})`

type PersistentStub = {
	ensureToken: () => Promise<void>
	listIssueComments: () => Promise<GhComment[]>
	editComment: (commentId: number, body: string) => Promise<void>
	deleteComment: (commentId: number) => Promise<void>
	getLatestCommitUrl: () => Promise<string>
	publishComment: (body: string, isTemporary?: boolean) => Promise<GhComment>
	publishPersistentComment: (
		content: string,
		initialHeader: string,
		name?: string,
		finalUpdateMessage?: boolean,
	) => Promise<void>
}

/** A GitHubProvider whose octokit-bound methods are recording fakes: the
 *  constructor calls createAppAuth (network/config), so build the object from
 *  the prototype and stub only what publishPersistentComment touches. */
function stubProvider(initialComments?: GhComment[]): {
	provider: PersistentStub
	edits: { id: number; body: string }[]
	deleted: number[]
	published: string[]
} {
	const edits: { id: number; body: string }[] = []
	const deleted: number[] = []
	const published: string[] = []
	const provider = Object.create(GitHubProvider.prototype) as PersistentStub
	provider.ensureToken = async () => {}
	provider.listIssueComments = async () =>
		initialComments ?? [
			{
				id: 7,
				body: `${INITIAL_HEADER}\n\nprevious review`,
				htmlUrl: "https://gh/comment/7",
				createdAt: "",
			},
		]
	provider.editComment = async (commentId: number, body: string) => {
		edits.push({ id: commentId, body })
	}
	provider.deleteComment = async (commentId: number) => {
		deleted.push(commentId)
	}
	provider.getLatestCommitUrl = async () => COMMIT_URL
	provider.publishComment = async (body: string) => {
		published.push(body)
		return { id: 99, body, htmlUrl: "https://gh/comment/99", createdAt: "" }
	}
	return { provider, edits, deleted, published }
}

describe("publishPersistentComment header (S9)", () => {
	test("adds the updated header when the new content does not contain it", async () => {
		const { provider, edits } = stubProvider()
		await provider.publishPersistentComment(
			"a review body with no header at all",
			INITIAL_HEADER,
			"review",
			false,
		)
		expect(edits.length).toBe(1)
		expect(edits[0].id).toBe(7)
		expect(edits[0].body).toContain(UPDATED_HEADER_NOTE)
		// must still start with the header so the next run finds this comment
		expect(edits[0].body.startsWith(INITIAL_HEADER)).toBe(true)
		expect(edits[0].body).toContain("a review body with no header at all")
	})

	test("replaces the header in place when the new content has it", async () => {
		const { provider, edits } = stubProvider()
		await provider.publishPersistentComment(
			`${INITIAL_HEADER}\n\nfresh review body`,
			INITIAL_HEADER,
			"review",
			false,
		)
		expect(edits.length).toBe(1)
		expect(edits[0].body.startsWith(INITIAL_HEADER)).toBe(true)
		expect(edits[0].body).toContain(UPDATED_HEADER_NOTE)
		expect(edits[0].body).toContain("fresh review body")
		// the stale previous body must be gone
		expect(edits[0].body).not.toContain("previous review")
	})

	test("matches and updates an existing comment when dependency facts precede the header", async () => {
		const existingComment = {
			id: 42,
			body: `### Dependency changes\n\n| Package | From | To | Change |\n\n${INITIAL_HEADER}\n\nprevious review`,
			htmlUrl: "https://gh/comment/42",
			createdAt: "",
		}
		const { provider, edits, published } = stubProvider([existingComment])
		const newContent = `### Dependency changes\n\n| Package | From | To | Change |\n\n${INITIAL_HEADER}\n\nfresh review`
		await provider.publishPersistentComment(newContent, INITIAL_HEADER, "review", false)
		// Must edit the existing comment instead of publishing a duplicate
		expect(edits.length).toBe(1)
		expect(edits[0].id).toBe(42)
		expect(edits[0].body).toContain(UPDATED_HEADER_NOTE)
		expect(edits[0].body).toContain("fresh review")
		expect(published.length).toBe(0)
	})

	test("cleans up older duplicate comments and updates the latest matching comment", async () => {
		const staleDup = {
			id: 10,
			body: `### Dependency changes\n\n${INITIAL_HEADER}\n\nstale review 1`,
			htmlUrl: "https://gh/comment/10",
			createdAt: "",
		}
		const latestDup = {
			id: 11,
			body: `### Dependency changes\n\n${INITIAL_HEADER}\n\nstale review 2`,
			htmlUrl: "https://gh/comment/11",
			createdAt: "",
		}
		const { provider, edits, deleted, published } = stubProvider([staleDup, latestDup])
		const newContent = `${INITIAL_HEADER}\n\nfresh unified review`
		await provider.publishPersistentComment(newContent, INITIAL_HEADER, "review", false)
		expect(deleted).toContain(10)
		expect(edits.length).toBe(1)
		expect(edits[0].id).toBe(11)
		expect(edits[0].body).toContain("fresh unified review")
		expect(published.length).toBe(0)
	})
})

// ── installation token cache ───────────────────────────────────────────────

type AuthStub = {
	token: string | null
	expiresAt: number
	appAuth: (opts: {
		type: string
		installationId?: number
	}) => Promise<{ token: string; expiresAt: string }>
	discoverInstallationId: (owner: string, repo: string) => Promise<number | null>
	installationToken: (owner: string, repo: string) => Promise<string>
}

function stubAuthClient(ttlMs: number): { client: AuthStub; mints: () => number } {
	let mints = 0
	const client = Object.create(AppAuthClient.prototype) as AuthStub
	client.token = null
	client.expiresAt = 0
	client.discoverInstallationId = async () => 42
	client.appAuth = async () => {
		mints++
		return { token: `tok_${mints}`, expiresAt: new Date(Date.now() + ttlMs).toISOString() }
	}
	return { client, mints: () => mints }
}

describe("AppAuthClient installation token cache", () => {
	test("mints once and reuses the token while more than 60s remain", async () => {
		const { client, mints } = stubAuthClient(3_600_000)
		expect(await client.installationToken("o", "r")).toBe("tok_1")
		expect(await client.installationToken("o", "r")).toBe("tok_1")
		expect(mints()).toBe(1)
	})

	test("refreshes when less than 60s remain before expiry", async () => {
		const { client, mints } = stubAuthClient(30_000) // 30s ttl < 60s margin
		expect(await client.installationToken("o", "r")).toBe("tok_1")
		expect(await client.installationToken("o", "r")).toBe("tok_2")
		expect(mints()).toBe(2)
	})
})

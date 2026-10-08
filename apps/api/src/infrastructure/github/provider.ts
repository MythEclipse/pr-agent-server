// GitHub App provider — port of pr_agent.git_providers.github_provider.
// Split out of the old src/github.ts (Task 3): App auth lives in ./client,
// the PR operations the review pipeline needs live here. Rate-limit-aware retry.

import { createHash } from "node:crypto"
import type { Octokit } from "@octokit/rest"
import { EditType, type FilePatchInfo, isGeneratedOrInvalidFile } from "../../legacy/diff/index.ts"
import type { Config } from "../config/legacy-config.ts"
import { AppAuthClient } from "./client.ts"
import { buildLargeDiff } from "./large-diff.ts"

export interface PullRequestData {
	number: number
	title: string
	body: string
	state: string
	head: { ref: string; sha: string; repo?: { name: string; owner?: { login: string } } }
	base: { ref: string; sha: string }
	htmlUrl: string
	additions: number
	deletions: number
	changedFiles: number
}

export interface GhComment {
	id: number
	body: string
	htmlUrl: string
	createdAt: string
}

const MAX_FILES_ALLOWED_FULL = 50

export class GitHubProvider {
	private authClient: AppAuthClient
	private octokit: Octokit
	readonly repo: string // owner/name
	readonly prNumber: number
	private pr: PullRequestData | null = null
	private diffs: FilePatchInfo[] | null = null

	constructor(
		private cfg: Config,
		repoOwner: string,
		repoName: string,
		prNumber: number,
		privateKeyPem: string,
	) {
		this.repo = `${repoOwner}/${repoName}`
		this.prNumber = prNumber
		this.authClient = new AppAuthClient(cfg, privateKeyPem)
		this.octokit = this.authClient.createInstallationOctokit()
	}

	/** Prefetch the installation token so the sync auth hook always has one.
	 *  Every public method that touches `this.octokit` awaits this first (S10). */
	private async ensureToken(): Promise<void> {
		const [owner, repo] = this.repo.split("/")
		await this.authClient.installationToken(owner, repo)
	}

	async getPr(): Promise<PullRequestData> {
		if (this.pr) return this.pr
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		const { data } = await this.retry(() =>
			this.octokit.pulls.get({ owner, repo, pull_number: this.prNumber }),
		)
		this.pr = {
			number: data.number,
			title: data.title,
			body: data.body ?? "",
			state: data.state ?? "",
			head: {
				ref: data.head.ref,
				sha: data.head.sha,
				repo: {
					name: data.head.repo?.name,
					owner: { login: data.head.repo?.owner?.login },
				},
			},
			base: { ref: data.base.ref, sha: data.base.sha },
			htmlUrl: data.html_url,
			additions: data.additions ?? 0,
			deletions: data.deletions ?? 0,
			changedFiles: data.changed_files ?? 0,
		}
		return this.pr
	}

	async getPrDescription(full = true): Promise<string> {
		await this.ensureToken()
		const pr = await this.getPr()
		return (full ? pr.body : pr.body) || ""
	}

	async getTitle(): Promise<string> {
		const pr = await this.getPr()
		return pr.title
	}

	async getPrBranch(): Promise<string> {
		await this.ensureToken()
		const pr = await this.getPr()
		return pr.head.ref
	}

	async getCommits(): Promise<string[]> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		const { data } = await this.retry(() =>
			this.octokit.pulls.listCommits({ owner, repo, pull_number: this.prNumber, per_page: 100 }),
		)
		return data.map((c) => c.commit?.message ?? "")
	}

	async getCommitMessagesStr(_maxTokens: number): Promise<string> {
		const messages = await this.getCommits()
		const str = messages.map((m, i) => `${i + 1}. ${m}`).join("\n")
		return str // caller clips with maxTokens
	}

	async getLanguages(): Promise<Record<string, number>> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		const resp = await this.retry(() => this.octokit.rest.repos.listLanguages({ owner, repo }))
		return resp.data as unknown as Record<string, number>
	}

	async getRepoFileContent(path: string, ref: string): Promise<string> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		try {
			const { data } = await this.retry(() =>
				this.octokit.repos.getContent({ owner, repo, path, ref }),
			)
			if (Array.isArray(data)) return ""
			if (!("content" in data) || typeof data.content !== "string") return ""
			return Buffer.from(data.content, "base64").toString("utf-8")
		} catch {
			return ""
		}
	}

	async getMergeBaseSha(): Promise<string> {
		await this.ensureToken()
		const pr = await this.getPr()
		const [owner, repo] = this.repo.split("/")
		try {
			const { data } = await this.retry(() =>
				this.octokit.repos.compareCommits({
					owner,
					repo,
					base: pr.base.sha,
					head: pr.head.sha,
				}),
			)
			return data.merge_base_commit?.sha ?? pr.base.sha
		} catch {
			return pr.base.sha
		}
	}

	async getDiffFiles(): Promise<FilePatchInfo[]> {
		await this.ensureToken()
		if (this.diffs) return this.diffs
		const pr = await this.getPr()
		const mergeBaseSha = await this.getMergeBaseSha()
		const [owner, repo] = this.repo.split("/")

		const { data: files } = await this.retry(() =>
			this.octokit.pulls.listFiles({ owner, repo, pull_number: this.prNumber, per_page: 100 }),
		)

		const diffFiles: FilePatchInfo[] = []
		let counterValid = 0
		for (const f of files) {
			const filename = f.filename
			if (!filename || isGeneratedOrInvalidFile(filename)) continue

			let patch = f.patch ?? ""
			let newContent = ""
			let baseContent = ""
			counterValid++
			const avoidLoad = counterValid >= MAX_FILES_ALLOWED_FULL && patch.length > 0
			if (!avoidLoad) {
				newContent = await this.getRepoFileContent(filename, pr.head.sha)
				baseContent = await this.getRepoFileContent(filename, mergeBaseSha)
			}
			if (!patch) {
				// build diff from base/head
				patch = buildLargeDiff(filename, baseContent, newContent)
			}
			if (!patch) continue

			let editType: EditType
			switch (f.status) {
				case "added":
					editType = EditType.ADDED
					break
				case "removed":
					editType = EditType.DELETED
					break
				case "renamed":
					editType = EditType.RENAMED
					break
				default:
					editType = EditType.MODIFIED
			}
			const numPlus = f.additions ?? 0
			const numMinus = f.deletions ?? 0
			diffFiles.push({
				filename,
				baseFile: baseContent,
				headFile: newContent,
				patch,
				editType,
				numPlusLines: numPlus,
				numMinusLines: numMinus,
			})
		}
		this.diffs = diffFiles
		return diffFiles
	}

	// ── publishing ──────────────────────────────────────────────────────────

	async publishComment(body: string, _isTemporary = false): Promise<GhComment> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		const { data } = await this.retry(() =>
			this.octokit.issues.createComment({
				owner,
				repo,
				issue_number: this.prNumber,
				body,
			}),
		)
		return {
			id: data.id,
			body: data.body ?? "",
			htmlUrl: data.html_url,
			createdAt: data.created_at,
		}
	}

	async editComment(commentId: number, body: string): Promise<void> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		await this.retry(() =>
			this.octokit.issues.updateComment({ owner, repo, comment_id: commentId, body }),
		)
	}

	async deleteComment(commentId: number): Promise<void> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		await this.retry(() =>
			this.octokit.issues.deleteComment({ owner, repo, comment_id: commentId }),
		)
	}

	async listIssueComments(): Promise<GhComment[]> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		const { data } = await this.retry(() =>
			this.octokit.issues.listComments({ owner, repo, issue_number: this.prNumber, per_page: 100 }),
		)
		return data.map((c) => ({
			id: c.id,
			body: c.body ?? "",
			htmlUrl: c.html_url,
			createdAt: c.created_at,
		}))
	}

	async addLabels(labelNames: string[]): Promise<void> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		if (!labelNames.length) return
		await this.retry(() =>
			this.octokit.issues.addLabels({
				owner,
				repo,
				issue_number: this.prNumber,
				labels: labelNames,
			}),
		)
	}

	async getLabels(): Promise<string[]> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		const { data } = await this.retry(() =>
			this.octokit.issues.listLabelsOnIssue({
				owner,
				repo,
				issue_number: this.prNumber,
				per_page: 100,
			}),
		)
		return data.map((l) => l.name)
	}

	/** Update the PR title/body (PATCH /pulls/{n}). Mirrors
	 *  git_provider.publish_description. */
	async updateDescription(title: string | null, body: string): Promise<void> {
		await this.ensureToken()
		const [owner, repo] = this.repo.split("/")
		await this.retry(() =>
			this.octokit.pulls.update({
				owner,
				repo,
				pull_number: this.prNumber,
				...(title !== null ? { title } : {}),
				body,
			}),
		)
	}

	/** Link to the relevant line in the PR diff files view. Mirrors
	 *  pr_agent get_line_link: SHA-256 hex of the filename as the diff anchor,
	 *  /pull/{n}/files#diff-<sha>R<start>-R<end>. */
	async getLineLink(
		filename: string,
		relevantLineStart = 1,
		relevantLineEnd?: number,
	): Promise<string> {
		// Warm the PR cache: getPr() memoises into this.pr, which getLineLink relies
		// on. The returned value is intentionally unused here.
		await this.getPr()
		const shaFile = createHash("sha256").update(filename, "utf8").digest("hex")
		let anchor: string
		if (relevantLineStart === -1) {
			anchor = `#diff-${shaFile}`
		} else if (relevantLineEnd && relevantLineEnd > relevantLineStart) {
			anchor = `#diff-${shaFile}R${relevantLineStart}-R${relevantLineEnd}`
		} else {
			anchor = `#diff-${shaFile}R${relevantLineStart}`
		}
		return `https://github.com/${this.repo}/pull/${this.prNumber}/files${anchor}`
	}

	async getPrUrl(): Promise<string> {
		const pr = await this.getPr()
		return pr.htmlUrl
	}

	/** Persistent comment: find a previous comment starting with `header` and
	 *  update it in place; else create new. Mirrors pr_agent behavior. */
	async publishPersistentComment(
		content: string,
		initialHeader: string,
		name = "review",
		finalUpdateMessage = true,
	): Promise<void> {
		const comments = await this.listIssueComments()
		for (const c of comments) {
			if (c.body.startsWith(initialHeader)) {
				const latestCommitUrl = await this.getLatestCommitUrl()
				const updatedHeader = `${initialHeader}\n\n#### (${name.charAt(0).toUpperCase() + name.slice(1)} updated until commit ${latestCommitUrl})\n`
				// S9: always publish the fresh content. If it lacks the header (e.g. a
				// review with no findings renders without one) prepend the updated
				// header, otherwise the next run could not find this comment.
				const updated = content.includes(initialHeader)
					? content.replace(initialHeader, updatedHeader)
					: `${updatedHeader}\n${content}`
				await this.editComment(c.id, updated)
				if (finalUpdateMessage) {
					await this.publishComment(
						`**[Persistent ${name}](<${c.htmlUrl}>)** updated to latest commit [${latestCommitUrl}](${latestCommitUrl})`,
					)
				}
				return
			}
		}
		await this.publishComment(content)
	}

	async getLatestCommitUrl(): Promise<string> {
		const pr = await this.getPr()
		return pr.head.sha
	}

	async removeInitialComment(initialBodyContains: string): Promise<void> {
		const comments = await this.listIssueComments()
		for (const c of comments) {
			if (c.body.includes(initialBodyContains) && c.body.includes("Preparing review")) {
				await this.deleteComment(c.id)
			}
		}
	}

	private async retry<T>(fn: () => Promise<T>): Promise<T> {
		let lastErr: unknown
		for (let attempt = 0; attempt < this.cfg.github.rateLimitRetries; attempt++) {
			try {
				return await fn()
			} catch (e) {
				lastErr = e
				const err = e as { status?: number; message?: string }
				// retry only on rate limit-ish errors
				if (
					err.status === 403 ||
					err.status === 429 ||
					(err.message ?? "").includes("rate limit")
				) {
					const delay =
						this.cfg.github.rateLimitDelaySec * 2 ** attempt * 1000 + Math.random() * 1000
					await new Promise((r) => setTimeout(r, delay))
					continue
				}
				throw e
			}
		}
		throw lastErr
	}
}

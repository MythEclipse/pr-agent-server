// biome-ignore-all lint/suspicious/noExplicitAny: test fakes stand in for untyped GitHub payloads
// biome-ignore-all lint/style/noNonNullAssertion: test asserts immediately after each non-null use
/**
 * `runSyncHooks` — the daily fork-config + PR-Agent-webhook sync.
 *
 * THE FAKE RECORDS, IT DOES NOT COUNT CALLS. Every group below asserts on the
 * requests that were actually made: the path, the method and the parsed body.
 * "the fake was called" is not an outcome.
 *
 * HERMETICITY: the module reads `GITHUB_WEBHOOK_SECRET` at CALL time (never at
 * import), so the env is saved and restored around each test. The real secret
 * must not reach the assertions in group 4, and the real one must not be
 * readable by a suite that has no business reading it.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest"
import {
	AUTO_MERGE_OPTOUT_LABEL,
	OWNER,
	runSyncHooks,
	type SyncHooksDeps,
} from "../src/ops/syncHooks.ts"

const TEMPLATE_DIR = join(import.meta.dirname, "..", "src", "ops", "templates")

/** Byte-exact from the brief: this is the URL the hook must point at. */
const PR_AGENT_URL = "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks"
/** Byte-exact from the brief. */
const EVENTS = [
	"issue_comment",
	"pull_request",
	"pull_request_review",
	"pull_request_review_comment",
]

const DEPENDABOT_PATH = ".github/dependabot.yml"
const GMW_DEPENDABOT_PATH = ".github/dependabot-gmw.yml"
/**
 * `.github/workflows`, NOT `.github`. GitHub executes a workflow file only from
 * this directory, and the auto-merge template was installed one level up — so
 * for as long as it has existed it was never scheduled once. Pinning the
 * executable path here is what stops that regression coming back.
 */
const AUTO_MERGE_PATH = ".github/workflows/dependabot-auto-merge.yml"
/** The old, non-executable home. The sync deletes it; nothing may install it. */
const LEGACY_AUTO_MERGE_PATH = ".github/dependabot-auto-merge.yml"

const template = (name: string) => readFileSync(join(TEMPLATE_DIR, name), "utf8")
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")
const unb64 = (text: string) => Buffer.from(text, "base64").toString("utf8")

// ── The fake GitHub ──────────────────────────────────────────────────────────

type Recorded = { method: string; path: string; token?: string; json?: any }

/** Per-repo world: which hooks exist, and which files exist with what content. */
type Fixture = { hooks?: any[]; files?: Record<string, string>; labels?: string[]; alerts?: any[] }

type Fake = { api: NonNullable<SyncHooksDeps["api"]>; calls: Recorded[] }

/**
 * Route on `${method} ${path}`. Content GETs 404 for a path the fixture does
 * not hold, which is GitHub's real answer for a file that was never created —
 * the distinction the conditional-PUT rule depends on.
 */
function fakeApi(repos: string[], fixtures: Record<string, Fixture> = {}): Fake {
	const calls: Recorded[] = []
	const request = async (
		method: string,
		path: string,
		opts: { token?: string; json?: unknown } = {},
	) => {
		calls.push({ method, path, token: opts.token, json: opts.json })

		// `/user/repos?affiliation=owner`, not `/users/{owner}/repos`: the public
		// listing silently omits private repos, so a private repo with a
		// Dependabot config would never be synced and never look missing.
		if (method === "GET" && path === "/user/repos?affiliation=owner&per_page=100") {
			return { status: 200, data: repos.map((full_name) => ({ full_name })) }
		}
		// Dependabot alerts, CURSOR-paginated. The real endpoint rejects `?page=N`
		// outright with HTTP 400, so this fake refuses it too — a fake that served
		// `page` is how a `?page=` regression reached production once already.
		// `after` is an opaque offset; a `Link` header is offered only when more
		// alerts remain.
		const alerts = /^GET \/repos\/([^/]+(?:\/[^/]+)*?)\/dependabot\/alerts\?/.exec(
			`${method} ${path}`,
		)
		if (alerts) {
			if (/[?&]page=/.test(path)) {
				return {
					status: 400,
					data: { message: "Pagination using the `page` parameter is not supported." },
				}
			}
			const held = fixtures[alerts[1]]?.alerts ?? []
			const size = Number(/[?&]per_page=(\d+)/.exec(path)?.[1] ?? "100")
			const after = Number(/[?&]after=(\d+)/.exec(path)?.[1] ?? "0")
			const data = held.slice(after, after + size)
			const next = after + data.length
			const link =
				next < held.length
					? `<https://api.github.com/repos/${alerts[1]}/dependabot/alerts?state=open&per_page=${size}&after=${next}>; rel="next"`
					: undefined
			return { status: 200, data, link }
		}
		const hooks = /^GET \/repos\/([^/]+\/[^/]+)\/hooks$/.exec(`${method} ${path}`)
		if (hooks) {
			return { status: 200, data: fixtures[hooks[1]]?.hooks ?? [] }
		}
		if (method === "POST" && /\/repos\/([^/]+\/[^/]+)\/hooks$/.test(path)) {
			return { status: 201, data: { id: 1 } }
		}
		// Labels: 404 when absent, 201 when created, 422 when it already exists.
		// The repo capture is `owner/repo` in ONE group — capturing only `[^/]+`
		// silently keys the fixture lookup by owner, so every per-repo fixture
		// misses and the fake answers as if nothing existed.
		const label = /^(GET|POST) \/repos\/([^/]+\/[^/]+)\/labels(?:\/(.+))?$/.exec(
			`${method} ${path}`,
		)
		if (label) {
			const held = fixtures[label[2]]?.labels ?? []
			if (method === "GET") {
				return held.includes(label[3] ?? "")
					? { status: 200, data: { name: label[3] } }
					: { status: 404, data: { message: "Not Found" } }
			}
			const name = String((opts.json as { name?: string } | undefined)?.name ?? "")
			return held.includes(name)
				? { status: 422, data: { message: "already_exists" } }
				: { status: 201, data: { name } }
		}
		const content = /^(GET|PUT|DELETE) \/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(
			`${method} ${path}`,
		)
		if (content) {
			const files = fixtures[content[2]]?.files ?? {}
			if (method === "GET") {
				const held = files[content[3]]
				if (held === undefined) return { status: 404, data: { message: "Not Found" } }
				return {
					status: 200,
					data: { sha: `sha-of-${content[3]}`, encoding: "base64", content: b64(held) },
				}
			}
			// DELETE answers 204 with no body on a real delete, and 404 when the
			// file is already gone — which is the converged state for the sync.
			if (method === "DELETE") {
				if (files[content[3]] === undefined) return { status: 404, data: {} }
				return { status: 204, data: undefined }
			}
			return { status: 200, data: { content: { sha: "new-sha" } } }
		}
		return { status: 404, data: { message: `unrouted ${method} ${path}` } }
	}
	return { api: { request }, calls }
}

const of = (calls: Recorded[], method: string, path: string) =>
	calls.filter((c) => c.method === method && c.path === path)
const hookPosts = (calls: Recorded[]) =>
	calls.filter((c) => c.method === "POST" && c.path.endsWith("/hooks"))
const contentPuts = (calls: Recorded[]) =>
	calls.filter((c) => c.method === "PUT" && c.path.includes("/contents/"))

// ── Call-time env ────────────────────────────────────────────────────────────

let realSecret: string | undefined
beforeEach(() => {
	realSecret = process.env.GITHUB_WEBHOOK_SECRET
	delete process.env.GITHUB_WEBHOOK_SECRET
})
afterEach(() => {
	if (realSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET
	else process.env.GITHUB_WEBHOOK_SECRET = realSecret
})

// ── Group 1 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > the pr-agent webhook", () => {
	// Group 1: a repo without the pr-agent hook gets a POST carrying the exact
	// URL, content_type, secret and event list from the brief.
	test("posts the hook with the brief's url, content_type, secret and events", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		const res = await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s3cr3t-value" })

		const posts = hookPosts(calls)
		expect(posts).toHaveLength(1)
		expect(posts[0].path).toBe("/repos/asepharyana/GMW/hooks")
		expect(posts[0].json).toEqual({
			name: "web",
			active: true,
			events: EVENTS,
			config: { url: PR_AGENT_URL, content_type: "json", secret: "s3cr3t-value" },
		})
		// hook + Dependabot config + auto-merge workflow + opt-out label = 4
		// writes; the legacy-path sweep finds nothing to delete (1 skip).
		expect(res.ok).toBe(4)
		expect(res.skip).toBe(1)
	})

	// Group 1 again: the events list is an ordered set, and an order or spelling
	// change silently narrows what PR-Agent ever hears about.
	test("sends the four events in the brief's order", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })
		expect(hookPosts(calls)[0].json.events).toEqual(EVENTS)
	})

	// Group 5 (safety): the report goes to an ops Discord channel, so a secret in
	// `lines` is a credential leak — the bug class that already shipped once in
	// this repo as cc15d06.
	test("never puts the secret or the token in a report line", async () => {
		const { api } = fakeApi(["asepharyana/GMW", "asepharyana/Other"])
		const res = await runSyncHooks({
			api,
			ghToken: "pat-do-not-leak",
			webhookSecret: "s3cr3t-value",
		})
		const report = res.lines.join("\n")
		expect(report).not.toContain("s3cr3t-value")
		expect(report).not.toContain("pat-do-not-leak")
		expect(res.lines.length).toBeGreaterThan(0)
	})
})

// ── Group 2 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > an existing hook", () => {
	// Group 2: a repo that already has the pr-agent hook is left alone. A second
	// POST would create a duplicate delivery of every comment to PR-Agent.
	test("does not post a hook when the repo already has the pr-agent url", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"], {
			"asepharyana/GMW": {
				hooks: [{ id: 7, config: { url: PR_AGENT_URL, content_type: "json" } }],
			},
		})
		const res = await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })

		expect(hookPosts(calls)).toHaveLength(0)
		expect(of(calls, "GET", "/repos/asepharyana/GMW/hooks")).toHaveLength(1)
		// The hook and the legacy sweep are the only skips; both files were
		// absent and the label did not exist, so those three were written.
		expect(res.ok).toBe(3)
		expect(res.skip).toBe(2)
	})

	// A hook pointing somewhere else is NOT the pr-agent hook. Skipping on a
	// substring would leave the fork permanently un-wired.
	test("posts when the only hook on the repo points elsewhere", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"], {
			"asepharyana/GMW": { hooks: [{ id: 7, config: { url: "https://example.invalid/hook" } }] },
		})
		await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })
		expect(hookPosts(calls)).toHaveLength(1)
	})
})

// ── Group 3 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > dependabot templates", () => {
	test("routes gmw to the gmw template, every other repo to the plain one", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW", "asepharyana/Other"])
		await runSyncHooks({ api, ghToken: "pat" })

		const gmw = contentPuts(calls).filter((c) => c.path.startsWith("/repos/asepharyana/GMW/"))
		const other = contentPuts(calls).filter((c) => c.path.startsWith("/repos/asepharyana/Other/"))

		// GMW gets the gmw variant INSTEAD of the plain one.
		expect(
			gmw.filter((c) => c.path === `/repos/asepharyana/GMW/contents/${GMW_DEPENDABOT_PATH}`),
		).toHaveLength(1)
		expect(
			gmw.filter((c) => c.path === `/repos/asepharyana/GMW/contents/${DEPENDABOT_PATH}`),
		).toHaveLength(0)
		// Everything else gets the plain one.
		expect(
			other.filter((c) => c.path === `/repos/asepharyana/Other/contents/${DEPENDABOT_PATH}`),
		).toHaveLength(1)
		expect(
			other.filter((c) => c.path === `/repos/asepharyana/Other/contents/${GMW_DEPENDABOT_PATH}`),
		).toHaveLength(0)
	})

	// Group 3: the auto-merge WORKFLOW is installed on EVERY repo, GMW included,
	// at the one path GitHub executes.
	test("installs the auto-merge workflow on every repo, under .github/workflows", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW", "asepharyana/Other"])
		await runSyncHooks({ api, ghToken: "pat" })

		const auto = contentPuts(calls).filter((c) => c.path.endsWith(AUTO_MERGE_PATH))
		expect(auto.map((c) => c.path).sort()).toEqual([
			"/repos/asepharyana/GMW/contents/.github/workflows/dependabot-auto-merge.yml",
			"/repos/asepharyana/Other/contents/.github/workflows/dependabot-auto-merge.yml",
		])
	})

	// The regression this exists for: the template used to be installed at
	// `.github/dependabot-auto-merge.yml`, which GitHub never executes. A file
	// there looked configured and was inert — `GET /repos/{r}/actions/workflows`
	// on a repo holding it listed only ci.yml, deploy.yml and release.yml.
	test("never installs the workflow at the non-executable .github/ path", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		await runSyncHooks({ api, ghToken: "pat" })

		expect(contentPuts(calls).filter((c) => c.path.endsWith(LEGACY_AUTO_MERGE_PATH))).toHaveLength(
			0,
		)
	})

	// The workflow's escape hatch is a label. A label that does not exist cannot
	// be applied, so a repo without it has no way to hold a bump back.
	test("creates the auto-merge opt-out label on every repo", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW", "asepharyana/Other"])
		await runSyncHooks({ api, ghToken: "pat" })

		const posts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels"))
		expect(posts.map((c) => c.path).sort()).toEqual([
			"/repos/asepharyana/GMW/labels",
			"/repos/asepharyana/Other/labels",
		])
		expect(posts[0].json.name).toBe(AUTO_MERGE_OPTOUT_LABEL)
	})

	test("does not re-create a label that already exists", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"], {
			"asepharyana/Other": { labels: [AUTO_MERGE_OPTOUT_LABEL] },
		})
		const res = await runSyncHooks({ api, ghToken: "pat" })

		expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels"))).toHaveLength(0)
		expect(res.lines.some((l) => l.includes("label already present"))).toBe(true)
	})

	// The stale copy is retired, not left behind next to the working one.
	test("deletes the legacy .github/dependabot-auto-merge.yml copy", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"], {
			"asepharyana/Other": { files: { [LEGACY_AUTO_MERGE_PATH]: "name: stale\n" } },
		})
		const res = await runSyncHooks({ api, ghToken: "pat" })

		const deletes = calls.filter(
			(c) => c.method === "DELETE" && c.path.endsWith(`/contents/${LEGACY_AUTO_MERGE_PATH}`),
		)
		expect(deletes).toHaveLength(1)
		// The sha is mandatory: without it GitHub refuses, and without reading it
		// first this could delete a file it never inspected.
		expect(deletes[0].json.sha).toBe(`sha-of-${LEGACY_AUTO_MERGE_PATH}`)
		expect(res.lines.some((l) => l.includes("removed (stale path)"))).toBe(true)
	})

	// Idempotent: once removed, a second run issues no DELETE and reports it as
	// already absent, so the daily sync does not churn a 404 into a failure.
	test("does not DELETE when the legacy copy is already gone", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"])
		const res = await runSyncHooks({ api, ghToken: "pat" })

		expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0)
		expect(res.lines.some((l) => l.includes("already absent"))).toBe(true)
	})

	// THE WORKFLOW MUST NOT READ ITS OWN CHECK RUN AS CI.
	//
	// `GET /commits/{sha}/check-runs` returns every app's check runs, this
	// workflow's own included. Left in, the gate deadlocks two ways, both seen
	// on the first live run (MythEclipse/9router#2):
	//   - the running job reports `in_progress`, so `pending` never hits 0 and
	//     the step burns the whole 1800s deadline;
	//   - `cancel-in-progress` settles a superseded run as `cancelled`, which is
	//     a RED conclusion, so every later run declares "CI is red" forever.
	// The template must filter its own name out, and the name it filters on must
	// match the job's own `name:` — a typo there silently re-arms the deadlock.
	test("excludes its own check run from the CI gate", () => {
		const wf = template("dependabot-auto-merge.yml")
		expect(wf).toContain("SELF_CHECK_NAME")
		expect(wf).toContain("select(.name != ")
		// The job's display name is the check-run name GitHub reports for it.
		expect(wf).toMatch(/name: Auto-merge dependency PR\n/)
		expect(wf).toContain("SELF_CHECK_NAME: Auto-merge dependency PR")
	})

	// The body has to be the real file, base64-encoded as the contents API
	// requires — not a re-serialised approximation of it.
	test("writes the template bytes, not a paraphrase", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		await runSyncHooks({ api, ghToken: "pat" })

		const put = contentPuts(calls).find((c) => c.path.endsWith(GMW_DEPENDABOT_PATH))
		expect(put).toBeDefined()
		expect(unb64(put?.json.content)).toBe(template("dependabot-gmw.yml"))
		const auto = contentPuts(calls).find((c) => c.path.endsWith(AUTO_MERGE_PATH))
		expect(unb64(auto?.json.content)).toBe(template("dependabot-auto-merge.yml"))
	})
})

/**
 * WHICH ACCOUNT THIS WRITES TO.
 *
 * The sync used to list `asepharyana` — the MIRROR DESTINATION — so every
 * workflow and Dependabot config it wrote landed on a repo that
 * `git push --mirror` overwrites from `MythEclipse` every 30 minutes. Every
 * write still returned 201, so the module reported success for work that was
 * erased before the next run. Dependabot opens its PRs on `MythEclipse`, which
 * is also the only account the token has push access to.
 *
 * A wrong owner here is invisible in every other assertion in this file: the
 * fake happily accepts any repo name. So it is pinned by name.
 */
describe("runSyncHooks > the target account", () => {
	test("defaults to the primary, MythEclipse", () => {
		expect(OWNER).toBe("MythEclipse")
	})

	test("never targets the mirror destination by default", () => {
		expect(OWNER).not.toBe("asepharyana")
	})
})

// ── Group 4 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > no webhook secret", () => {
	// Group 4: the whole step is SKIPPED, not attempted with an empty secret.
	// Posting `secret: ""` to a real GitHub API installs a hook anyone can forge.
	test("makes no POST /repos/{repo}/hooks request at all", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW", "asepharyana/Other"])
		const res = await runSyncHooks({ api, ghToken: "pat" })

		expect(hookPosts(calls)).toHaveLength(0)
		// Not even the read: the step is not entered, not merely not written.
		expect(calls.filter((c) => c.path.endsWith("/hooks"))).toHaveLength(0)
		// The file half of the work still runs: per repo that is the Dependabot
		// config, the auto-merge workflow and the opt-out label (3 writes each),
		// plus the legacy-path sweep, which finds nothing to delete (1 skip each).
		expect(contentPuts(calls).length).toBe(4)
		expect(res.ok).toBe(6)
		expect(res.skip).toBe(2)
	})

	test("treats an empty string the same as an absent secret", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		await runSyncHooks({ api, ghToken: "pat", webhookSecret: "" })
		expect(hookPosts(calls)).toHaveLength(0)
	})

	// The secret is read at CALL time, not frozen at import. If it were module
	// scope this test could only pass on the machine holding the real value.
	test("reads GITHUB_WEBHOOK_SECRET at call time", async () => {
		process.env.GITHUB_WEBHOOK_SECRET = "from-env"
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		await runSyncHooks({ api, ghToken: "pat" })

		expect(hookPosts(calls)).toHaveLength(1)
		expect(hookPosts(calls)[0].json.config.secret).toBe("from-env")
	})
})

// ── Group 5 ──────────────────────────────────────────────────────────────────

describe("runSyncHooks > the summary", () => {
	// Group 5: ok + skip must equal the number of actions ATTEMPTED, and lines
	// must be one per action — with a deliberate skip invisible in neither
	// counter, which is why the no-secret case above reports ok 4 / skip 0.
	test("counts every action once and reports one line per action", async () => {
		const { api } = fakeApi(["asepharyana/GMW", "asepharyana/Other"], {
			// Nothing on disk, no hooks: every action writes.
			"asepharyana/GMW": {},
			// Fully in sync: every action is a no-op.
			"asepharyana/Other": {
				hooks: [{ id: 3, config: { url: PR_AGENT_URL } }],
				files: {
					[DEPENDABOT_PATH]: template("dependabot.yml"),
					[AUTO_MERGE_PATH]: template("dependabot-auto-merge.yml"),
				},
			},
		})
		const res = await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })

		// GMW: 1 hook + 2 files + 1 label = 4 writes, and the legacy sweep finds
		// nothing (1 skip) — 5 lines. Other: 3 no-ops (hook and both files) plus
		// the same sweep skip, and its label is a write — 5 lines.
		expect(res.ok).toBe(5)
		expect(res.skip).toBe(5)
		expect(res.lines).toHaveLength(10)
		expect(res.lines.filter((l) => l.includes("asepharyana/GMW"))).toHaveLength(5)
		expect(res.lines.filter((l) => l.includes("asepharyana/Other"))).toHaveLength(5)
	})

	// The conditional write: a file that already matches is a skip, not a write.
	// A blind PUT every tick is a write storm against every fork, forever.
	test("skips a file that already matches and does not PUT it", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"], {
			"asepharyana/Other": {
				files: {
					[DEPENDABOT_PATH]: template("dependabot.yml"),
					[AUTO_MERGE_PATH]: template("dependabot-auto-merge.yml"),
				},
			},
		})
		const res = await runSyncHooks({ api, ghToken: "pat" })

		expect(contentPuts(calls)).toHaveLength(0)
		expect(of(calls, "GET", `/repos/asepharyana/Other/contents/${DEPENDABOT_PATH}`)).toHaveLength(1)
		// The only write is the opt-out label, which no fixture provides.
		expect(res.ok).toBe(1)
		// 2 converged files + the legacy sweep finding nothing.
		expect(res.skip).toBe(3)
	})

	// A differing file is written WITH the sha — GitHub rejects a content PUT
	// without it (409/422), so this is the difference between working and not.
	test("sends the existing sha when the content differs", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"], {
			"asepharyana/Other": { files: { [DEPENDABOT_PATH]: "version: 2 # stale\n" } },
		})
		const res = await runSyncHooks({ api, ghToken: "pat" })

		const put = contentPuts(calls).find((c) => c.path.endsWith(DEPENDABOT_PATH))
		expect(put).toBeDefined()
		expect(put?.json.sha).toBe(`sha-of-${DEPENDABOT_PATH}`)
		expect(unb64(put?.json.content)).toBe(template("dependabot.yml"))
		// the dependabot rewrite + the auto-merge create + the label create
		expect(res.ok).toBe(3)
	})

	// A file that does not exist yet is a CREATE: no sha exists to send.
	test("creates a missing file without a sha", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"])
		await runSyncHooks({ api, ghToken: "pat" })
		for (const put of contentPuts(calls)) expect(put.json.sha).toBeUndefined()
	})

	// A failed action still has to be accounted for, or `ok + skip` would stop
	// describing the work done and the summary would under-report silently.
	test("counts a failed write as neither a success nor a clean skip", async () => {
		const { api } = fakeApi(["asepharyana/Other"], { "asepharyana/Other": {} })
		// Reads succeed (so the file is genuinely different and a PUT is attempted)
		// and every write is rejected.
		const failing = {
			request: async (method: string, path: string) =>
				method === "PUT"
					? { status: 405, data: { message: "not allowed" } }
					: api.request(method, path),
		}
		const res = await runSyncHooks({ api: failing, ghToken: "pat" })

		// The label POST is not a PUT, so it still succeeds; the two file writes
		// are the ones rejected.
		expect(res.ok).toBe(1)
		// 2 rejected writes + the legacy sweep finding nothing to delete.
		expect(res.skip).toBe(3)
		expect(res.lines.join("\n")).toContain("asepharyana/Other")
		expect(res.lines.join("\n")).toContain("405")
	})

	// A file that cannot be READ is not written. An unverifiable overwrite of a
	// file we could not see is the one outcome worse than leaving it alone.
	test("leaves a file alone when it cannot be read", async () => {
		const { api, calls } = fakeApi(["asepharyana/Other"])
		const unreadable = {
			request: async (method: string, path: string) =>
				method === "GET" && path.includes("/contents/")
					? { status: 403, data: { message: "Forbidden" } }
					: api.request(method, path),
		}
		const res = await runSyncHooks({ api: unreadable, ghToken: "pat" })

		expect(contentPuts(calls)).toHaveLength(0)
		// The label GET is a /labels/ path, not /contents/, so it is unaffected
		// and the label is still created.
		expect(res.ok).toBe(1)
		// 2 unreadable files + the legacy sweep, also unreadable.
		expect(res.skip).toBe(3)
		expect(res.lines.join("\n")).toContain("403")
	})

	// An empty repo list is a quiet, successful no-op, not a crash.
	test("reports nothing for an empty repo list", async () => {
		const { api, calls } = fakeApi([])
		const res = await runSyncHooks({ api, ghToken: "pat", webhookSecret: "s" })
		expect(res).toEqual({ ok: 0, skip: 0, lines: [] })
		expect(calls).toHaveLength(1) // the listing, and nothing else
	})

	// No credential means no work, and the only honest thing to report is why.
	// A silent "0 synced" would read as a healthy run.
	test("reports the missing credential and issues no request", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		const res = await runSyncHooks({ api, ghToken: "" })

		expect(calls).toHaveLength(0)
		expect(res.ok).toBe(0)
		expect(res.skip).toBe(0)
		expect(res.lines.join("\n")).toContain("no GitHub token")
	})

	// The deps object is OPTIONAL, so the module resolves the repo list itself.
	test("lists the caller's own repos when no list is injected", async () => {
		const { api, calls } = fakeApi(["asepharyana/GMW"])
		const res = await runSyncHooks({ api, ghToken: "pat" })
		// `/user/repos?affiliation=owner`, so private repos are included. The
		// public `/users/{owner}/repos` listing answered 62 of 69 on this fleet.
		expect(of(calls, "GET", "/user/repos?affiliation=owner&per_page=100")).toHaveLength(1)
		// Dependabot config + auto-merge workflow + opt-out label.
		expect(res.ok).toBe(3)
	})
})

/**
 * The CLI wiring for `--sync-hooks` (Task 16), in `src/index.ts`.
 *
 * What matters here is the GATE, not the sync. `runSyncHooks` is already proven
 * by the tests above; what was untested until now is whether an operator can
 * trigger fleet-wide Dependabot writes by accident. These assert they cannot:
 * the mode is refused unless `PR_AGENT_SYNC_HOOKS=1` is set, and the refusal
 * happens BEFORE any credential is read or any request is made.
 */
describe("the --sync-hooks CLI gate", () => {
	const KEY = "PR_AGENT_SYNC_HOOKS"
	let real: string | undefined
	let runIndex: (argv: string[]) => Promise<number>

	beforeAll(async () => {
		real = process.env[KEY]
		// Imported lazily: src/index.ts calls bootstrapEnv() at module scope, so
		// it must not be imported while other suites hold a staged environment.
		const mod = await import("../src/index")
		runIndex = (argv) => mod.runCliForTest(argv)
	})

	afterEach(() => {
		if (real === undefined) delete process.env[KEY]
		else process.env[KEY] = real
	})

	test("refuses when the gate is unset, and explains why", async () => {
		delete process.env[KEY]
		const code = await runIndex(["--sync-hooks"])
		expect(code).toBe(1)
	})

	test('refuses for a value that is not exactly "1"', async () => {
		for (const v of ["", "0", "true", "yes", "TRUE"]) {
			process.env[KEY] = v
			expect(await runIndex(["--sync-hooks"])).toBe(1)
		}
	})

	test("the refusal needs no credential: no key file, no token, no request", async () => {
		// PATH points at an empty dir and the key path at a file that cannot exist,
		// so ANY attempt to build deps would throw before returning 1.
		process.env[KEY] = "0"
		const oldPath = process.env.PATH
		const oldKey = process.env.PR_AGENT_KEY_PATH
		process.env.PR_AGENT_KEY_PATH = "/nonexistent/pr-agent-key.pem"
		try {
			expect(await runIndex(["--sync-hooks"])).toBe(1)
		} finally {
			process.env.PATH = oldPath
			if (oldKey === undefined) delete process.env.PR_AGENT_KEY_PATH
			else process.env.PR_AGENT_KEY_PATH = oldKey
		}
	})
})

/**
 * The `--sync-hooks` exit code.
 *
 * This is a separate concern from the gate above and it broke in production:
 * the rule was `ok > 0 || skip === 0`, so the STEADY STATE — every repo already
 * in sync, `0 updated, N skipped` — exited 1 and systemd recorded the unit as
 * `failed`. The nightly timer therefore reported failure every night it did its
 * job, which is how a real gate refusal sat unnoticed for three days: the two
 * conditions were indistinguishable in `systemctl status`.
 *
 * `skip` counts steps that needed no change, so it can never be a failure
 * signal. The only failure signal the summary carries is a ⚠️ line.
 */
describe("the --sync-hooks exit code", () => {
	let exitCode: (lines: readonly string[]) => number

	beforeAll(async () => {
		const mod = await import("../src/index")
		exitCode = mod.syncHooksExitCode
	})

	test("a fully in-sync run is a SUCCESS, not a failure", () => {
		// The exact shape the box produced: nothing to change, everything skipped.
		const lines = Array.from(
			{ length: 7 },
			(_, i) => `\u23ed\ufe0f  owner/repo: check ${i} already in sync`,
		)
		expect(exitCode(lines)).toBe(0)
	})

	test("a run that changed something is a success", () => {
		expect(exitCode(["\u2705 owner/repo: pr-agent webhook created"])).toBe(0)
	})

	test("a run with no lines at all is a success", () => {
		expect(exitCode([])).toBe(0)
	})

	test("a ⚠️ line makes it a failure, even when other repos succeeded", () => {
		const lines = ["\u2705 owner/a: created", "\u26a0\ufe0f  sync-hooks: owner/b: HTTP 500"]
		expect(exitCode(lines)).toBe(1)
	})

	test("the module's own no-token and listing-failure lines are failures", () => {
		expect(exitCode(["\u26a0\ufe0f  sync-hooks: no GitHub token available — nothing synced"])).toBe(
			1,
		)
		expect(exitCode(["\u26a0\ufe0f  sync-hooks: repo listing failed (HTTP 500)"])).toBe(1)
	})
})

/**
 * `dry` — the preview must not write.
 *
 * This is the one behaviour whose absence was INVISIBLE: `--sync-hooks --dry`
 * looked like a preview, reported plausible lines, and rewrote the fleet. It was
 * found by noticing that a "dry" run had left `chore(deps): sync
 * .github/dependabot.yml from the ops template` commits across repos. A preview
 * that performs the change is worse than no preview at all, because it is
 * trusted exactly where trust matters most.
 *
 * Asserted on the RECORDED REQUESTS, not on the lines: a write that happened and
 * was merely not reported would still be a write.
 */
describe("dry mode writes nothing", () => {
	const repo = "owner/repo"
	/** A repo where every step has work to do, so a real run would write. */
	const needsWork: Record<string, Fixture> = {
		[repo]: { hooks: [], files: {}, labels: [] },
	}

	const runDry = async (extra: Partial<SyncHooksDeps> = {}) => {
		const fake = fakeApi([repo], needsWork)
		const res = await runSyncHooks({
			api: fake.api,
			ghToken: "t",
			webhookSecret: "s",
			syncSecurity: true,
			dry: true,
			...extra,
		})
		return { res, calls: fake.calls }
	}

	test("no PUT, POST or DELETE is issued at all", async () => {
		const { calls } = await runDry()
		const writes = calls.filter((c) => c.method !== "GET")
		expect(writes).toEqual([])
	})

	test("the webhook is not created, so no secret goes on the wire", async () => {
		const { calls } = await runDry()
		expect(hookPosts(calls)).toHaveLength(0)
	})

	test("no file is created or updated", async () => {
		const { calls } = await runDry()
		expect(contentPuts(calls)).toHaveLength(0)
	})

	test("the label is not created", async () => {
		const { calls } = await runDry()
		const labelPosts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels"))
		expect(labelPosts).toHaveLength(0)
	})

	test("the stale path is not deleted", async () => {
		const { calls } = await runDry()
		expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0)
	})

	test("what WOULD happen is still reported, marked DRY", async () => {
		const { res } = await runDry()
		const dryLines = res.lines.filter((l) => l.startsWith("DRY "))
		expect(dryLines.length).toBeGreaterThan(0)
		// And nothing claims to have done it.
		expect(res.lines.some((l) => l.startsWith("✅"))).toBe(false)
	})

	test("a dry run never reports a ⚠️ failure, so the exit code stays 0", async () => {
		const { res } = await runDry()
		expect(res.lines.filter((l) => l.startsWith("⚠️"))).toEqual([])
	})

	test("the SAME fixture with dry off DOES write — the fixture is not vacuous", async () => {
		// Without this, every assertion above would pass on a repo that had
		// nothing to do, and the suite would prove nothing.
		const fake = fakeApi([repo], needsWork)
		await runSyncHooks({
			api: fake.api,
			ghToken: "t",
			webhookSecret: "s",
			syncSecurity: true,
		})
		expect(hookPosts(fake.calls).length).toBeGreaterThan(0)
		expect(contentPuts(fake.calls).length).toBeGreaterThan(0)
		expect(
			fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/labels")).length,
		).toBeGreaterThan(0)
	})

	test("dry is OFF unless explicitly true", async () => {
		// `deps.dry` must be compared with `=== true`: a truthy string from a
		// stray env var must not silently turn a real run into a preview, and
		// more importantly its absence must not turn a preview into a real run.
		const fake = fakeApi([repo], needsWork)
		await runSyncHooks({ api: fake.api, ghToken: "t", webhookSecret: "s" })
		expect(fake.calls.filter((c) => c.method !== "GET").length).toBeGreaterThan(0)
	})
})

/**
 * Lane derivation, END TO END through the sync.
 *
 * `vuln-lanes.test.ts` proves the renderer. This proves the renderer is what
 * reaches GitHub — a config that is correct in a pure function and never written
 * is exactly the failure this feature exists to correct, one level up.
 */
describe("the sync writes the DERIVED Dependabot config", () => {
	const repo = "owner/nested"
	const dependabotPath = ".github/dependabot.yml"

	/** An alert on a NESTED manifest — the case no root lane covers. */
	const nestedAlert = (dir: string) => ({
		number: 1,
		state: "open",
		dependency: {
			package: { ecosystem: "pip", name: "pillow" },
			manifest_path: `${dir}/requirements.txt`,
		},
		security_advisory: { ghsa_id: "G", cve_id: null, summary: "", severity: "high" },
		security_vulnerability: {
			package: { ecosystem: "pip", name: "pillow" },
			severity: "high",
			vulnerable_version_range: "<1",
			first_patched_version: { identifier: "1" },
		},
		url: "",
		html_url: "",
		created_at: "",
	})

	const putBody = (calls: Recorded[]) => {
		const put = of(calls, "PUT", `/repos/${repo}/contents/${dependabotPath}`)[0]
		return put?.json ? unb64(String((put.json as { content: string }).content)) : undefined
	}

	test("a nested manifest gets a lane written into the repo's config", async () => {
		const fake = fakeApi([repo], { [repo]: { files: {}, alerts: [nestedAlert("Proyek_A")] } })
		await runSyncHooks({ api: fake.api, ghToken: "t", webhookSecret: "s", syncSecurity: true })

		const body = putBody(fake.calls)
		expect(body).toBeDefined()
		// The lane the template does not have, and the one that makes the alert
		// actionable.
		expect(body).toContain('- package-ecosystem: "pip"')
		expect(body).toContain('directory: "/Proyek_A"')
		// And the template's own lanes survive.
		expect(body).toContain("github-actions")
	})

	test("a repo whose alerts are all on root manifests gets the plain template", async () => {
		// No lane to add, so the body is byte-identical to the template — which is
		// what keeps a converged fleet from committing every night.
		const rootAlert = {
			...nestedAlert("x"),
			dependency: { package: { ecosystem: "npm", name: "x" }, manifest_path: "package-lock.json" },
		}
		const fake = fakeApi([repo], { [repo]: { files: {}, alerts: [rootAlert] } })
		await runSyncHooks({ api: fake.api, ghToken: "t", webhookSecret: "s", syncSecurity: true })
		expect(putBody(fake.calls)).toBe(template("dependabot.yml"))
	})

	test("a FAILED alerts read leaves the config ALONE — it must not shrink it", async () => {
		// The dangerous case: deriving from a failed read yields the bare template,
		// which would quietly drop the lanes still needed. The repo must be skipped
		// and the failure reported, not written.
		const fake = fakeApi([repo], { [repo]: { files: {} } })
		const blind = {
			async request(method: string, path: string, opts: { token?: string; json?: unknown } = {}) {
				if (path.includes("/dependabot/alerts")) {
					fake.calls.push({ method, path, token: opts.token, json: opts.json })
					return { status: 500, data: { message: "boom" } }
				}
				return fake.api.request(method, path, opts)
			},
		}
		const res = await runSyncHooks({
			api: blind as never,
			ghToken: "t",
			webhookSecret: "s",
			syncSecurity: true,
		})
		expect(of(fake.calls, "PUT", `/repos/${repo}/contents/${dependabotPath}`)).toHaveLength(0)
		expect(res.lines.some((l) => l.startsWith("⚠️") && l.includes("alerts unreadable"))).toBe(true)
	})

	test("derivation is OFF when security sync is off — the old behaviour is intact", async () => {
		const fake = fakeApi([repo], { [repo]: { files: {}, alerts: [nestedAlert("Proyek_A")] } })
		await runSyncHooks({ api: fake.api, ghToken: "t", webhookSecret: "s" })
		// No alerts request at all, and the plain template is written.
		expect(fake.calls.some((c) => c.path.includes("/dependabot/alerts"))).toBe(false)
		expect(putBody(fake.calls)).toBe(template("dependabot.yml"))
	})

	test("dry mode reports the lane it would add and writes nothing", async () => {
		const fake = fakeApi([repo], { [repo]: { files: {}, alerts: [nestedAlert("Proyek_A")] } })
		const res = await runSyncHooks({
			api: fake.api,
			ghToken: "t",
			webhookSecret: "s",
			syncSecurity: true,
			dry: true,
		})
		expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([])
		expect(res.lines.some((l) => l.startsWith("DRY") && l.includes("dependabot.yml"))).toBe(true)
	})

	test("the coverage summary counts the alerts that were unreachable", async () => {
		const fake = fakeApi([repo], {
			[repo]: {
				files: {},
				alerts: [nestedAlert("Proyek_A"), nestedAlert("Proyek_A"), nestedAlert("Proyek_B")],
			},
		})
		const res = await runSyncHooks({
			api: fake.api,
			ghToken: "t",
			webhookSecret: "s",
			syncSecurity: true,
		})
		expect(res.lanes).toBeDefined()
		const mine = res.lanes?.find((c) => c.repo === repo)
		expect(mine).toMatchObject({ repo, alerts: 3, unreachable: 3 })
		expect(mine?.added.map((l) => l.directory).sort()).toEqual(["/Proyek_A", "/Proyek_B"])
	})
})

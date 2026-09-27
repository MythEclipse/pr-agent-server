/**
 * Fork config + PR-Agent webhook sync — the daily `sync-pr-agent-hooks-daily`
 * job, replacing `~/.hermes/scripts/pr-ops-notifier.py`.
 *
 * WHAT IT DOES, per fork under `asepharyana`: make sure the pr-agent webhook
 * exists, and make sure the two Dependabot config files match the templates
 * this module ships. Every action is reported, so the operator-facing summary
 * says exactly what changed and what was already correct.
 *
 * FOUR INVARIANTS, each of which has already cost this repo a bug:
 *
 * 1. NO CREDENTIAL EVER REACHES `lines`. The array goes to an ops Discord
 *    channel via `postDiscordOps`. A token or a webhook secret in a report line
 *    is a credential leak, and that exact bug class shipped once here (worker
 *    fix cc15d06). Lines are built from repo names, paths and outcomes only.
 * 2. NO SECRET IN `process.env` AT MODULE SCOPE. `GITHUB_WEBHOOK_SECRET` and the
 *    PAT are read inside `runSyncHooks`, at CALL time, or `deps` supplies them.
 *    A module-scope read froze the value at import and made a suite pass only
 *    on the machine holding the real credential.
 * 3. THE WEBHOOK STEP IS SKIPPED ENTIRELY WITHOUT A SECRET — not "posted with an
 *    empty secret". `POST /repos/{repo}/hooks` with `secret: ""` installs a hook
 *    whose payloads anyone can forge, on every fork, permanently. So the guard
 *    is placed BEFORE the hook listing: with no secret, not even the
 *    `GET /repos/{repo}/hooks` is issued.
 * 4. CONTENT WRITES ARE CONDITIONAL AND CARRY THE SHA. `GET` the file, compare
 *    the decoded bytes, and `PUT` only on a difference — and always with the
 *    `sha` the GET returned, because GitHub rejects a content `PUT` without it
 *    (409/422). A blind `PUT` every tick is a write storm against every fork,
 *    forever, and it churns the default branch for no reason.
 *
 * WHY `deps.api` AND NOT A `fetch`: the brief's signature names a `fetch`, but
 * this codebase already has the request seam this work belongs behind —
 * `GhClient` (`pr/scan.ts`), which `GitHubApi` (`github.ts`) satisfies. Routing
 * through it means one auth scheme, one retry policy, one `{status: 0}` failure
 * sentinel, and a test fake that records typed requests instead of parsing
 * headers off a `Response`. A second `fetch` layer here would be a duplicate
 * with its own bug surface. `GitHubApi` satisfies `GhClient` structurally, so
 * production wiring is unchanged.
 *
 * `deps` IS OPTIONAL, which is the point: with no argument, `runSyncHooks`
 * resolves its own PAT (`gh auth token`, a local read via `GitHubApi`), its own
 * client, and its own repo list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubApi } from "../github";
import type { GhClient } from "../pr/scan";

/** The owner whose forks are synced — the brief's `GET /users/asepharyana/repos`. */
export const OWNER = "asepharyana";

/**
 * The webhook target, byte-exact from the brief. Also the DEFAULT for
 * `index.ts`'s `PR_AGENT_WEBHOOK_URL`, so the two cannot drift.
 */
export const PR_AGENT_WEBHOOK_URL = "https://pr-agent.asepharyana.my.id/api/v1/github_webhooks";

/**
 * The four events, in the brief's order.
 *
 * The ORDER is asserted, not incidental: it is the difference between a
 * recognisable request log and an unreproducible one. The SET is also
 * load-bearing — drop `pull_request_review_comment` and PR-Agent stops seeing
 * review threads, silently, with no error anywhere.
 */
export const WEBHOOK_EVENTS = [
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
] as const;

/** The one repo with its own Dependabot config. */
export const GMW_REPO = "asepharyana/GMW";

/** Template filenames, and the `.github/` paths they are installed to. */
const DEPENDABOT_FILE = "dependabot.yml";
const GMW_DEPENDABOT_FILE = "dependabot-gmw.yml";
const AUTO_MERGE_FILE = "dependabot-auto-merge.yml";
const GITHUB_DIR = ".github";
const DEPENDABOT_PATH = `${GITHUB_DIR}/${DEPENDABOT_FILE}`;
const GMW_DEPENDABOT_PATH = `${GITHUB_DIR}/${GMW_DEPENDABOT_FILE}`;
const AUTO_MERGE_PATH = `${GITHUB_DIR}/${AUTO_MERGE_FILE}`;

/** Python's `per_page=100` on the owner listing. */
const REPO_LIST_PATH = `/users/${OWNER}/repos?per_page=100`;

/**
 * `GhClient`, plus the one optional method this module uses to self-resolve a
 * PAT. Declared STRUCTURALLY rather than as `GitHubApi` for the reason
 * `pr/scan.ts` gives: narrowing it to the concrete class would force every test
 * to build an RSA key to exercise a pure routing rule. A fake with only
 * `request` still satisfies this, and `GitHubApi` satisfies it fully.
 */
export type SyncApi = GhClient & { fetchGhToken?: () => string };

/**
 * The collaborators. Every field is optional so `runSyncHooks()` is callable
 * bare, and every one of them is resolved at CALL time.
 */
export type SyncHooksDeps = {
  /**
   * The GitHub seam — `GitHubApi` in production, a recording fake in tests.
   * Defaults to a `GitHubApi` built with an EMPTY private key, which is safe
   * here and only here: every request this module issues carries an explicit
   * `token`, so `request` takes the `token` branch and the key is never used.
   * A call that reached the `Bearer` branch would throw inside `createSign`,
   * which is why the token is checked before the first request rather than
   * wrapped in a try.
   */
  api?: SyncApi;
  /** `gh auth token`. An empty value means nothing is synced — see the guard. */
  ghToken?: string;
  /** `GITHUB_WEBHOOK_SECRET`. Absent or empty skips the webhook step entirely. */
  webhookSecret?: string;
  /** Injectable repo list; when absent, the owner listing is used. */
  repos?: string[];
};

/** The brief's return shape. `ok + skip` is the number of actions attempted. */
export type SyncSummary = { ok: number; skip: number; lines: string[] };

// ── Templates ────────────────────────────────────────────────────────────────

/**
 * Resolved from the module's own directory, not from `process.cwd()`: a cron
 * wrapper may `cd` anywhere, and a wrong directory would mean a silent
 * "template not found" on a live run.
 */
const TEMPLATE_DIR = join(import.meta.dir, "templates");

/**
 * Template bodies, read LAZILY and cached.
 *
 * Both halves matter. Not at import: a module-scope `readFileSync` is filesystem
 * access at import time, which makes the module unimportable from a test that
 * has not staged the files, and it is one of the two rules this repo enforces
 * on every new module. Cached because a run touches every fork with the same
 * three bodies, and re-reading a file per repo per tick is pure waste.
 *
 * A MISSING TEMPLATE THROWS rather than degrading. These files ship in the
 * same package as the code; a missing one is a broken deployment, and
 * continuing would mean writing an empty Dependabot config to every fork —
 * silently disabling dependency updates fleet-wide. The caller turns that into
 * one report line instead of a stack trace.
 */
const templateCache = new Map<string, string>();

function templateBody(file: string): string {
  const cached = templateCache.get(file);
  if (cached !== undefined) return cached;
  const body = readFileSync(join(TEMPLATE_DIR, file), "utf8");
  templateCache.set(file, body);
  return body;
}

/** The Dependabot config a repo gets: GMW has its own, everything else shares. */
const dependabotFileFor = (repo: string) => (repo === GMW_REPO ? GMW_DEPENDABOT_FILE : DEPENDABOT_FILE);
const dependabotPathFor = (repo: string) => (repo === GMW_REPO ? GMW_DEPENDABOT_PATH : DEPENDABOT_PATH);

// ── Helpers ──────────────────────────────────────────────────────────────────

const asObject = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Decode a `GET /repos/{repo}/contents/{path}` body to the file's bytes.
 *
 * THE NEWLINE STRIP IS LOAD-BEARING. GitHub returns `content` base64-wrapped at
 * 60 characters with `\n` between the lines; a test fixture that returns
 * unbroken base64 would pass against a naive `Buffer.from(x, "base64")` and
 * then, against real GitHub, EVERY read would "differ" from its template and
 * every tick would rewrite every fork's file forever. The comparison has to
 * normalise GitHub's line wrapping, or the conditional write is not conditional
 * in production.
 */
function decodeContent(data: unknown): string | undefined {
  const body = asObject(data);
  if (!body) return undefined;
  if (str(body.encoding) !== "base64") return str(body.content);
  const raw = str(body.content).replace(/\s+/g, "");
  if (!raw) return "";
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return undefined; // not base64: treat as unreadable, never as "matches"
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** One action's outcome, accumulated into the summary by the caller. */
type Step = { ok: boolean; line: string };

/**
 * Step 1 — make sure the repo has the pr-agent webhook.
 *
 * `GET /repos/{repo}/hooks` → if any hook's `config.url` is already
 * `PR_AGENT_WEBHOOK_URL`, do nothing. `POST`ing a second one would deliver
 * every comment to PR-Agent twice, which is how the duplicate-comment incident
 * on GMW #22 happened in the first place.
 *
 * The match is EXACT EQUALITY, not a substring test. A hook pointing at some
 * other endpoint is a different hook, and treating it as a match would leave
 * the fork permanently unwired while the report cheerfully said "in sync".
 *
 * A non-200 listing is treated as "no hooks" and the POST is attempted: the
 * honest read of a failed listing is unknown, and not wiring the hook is a
 * worse failure than a 422 from the POST. The line says which it was.
 */
async function syncHook(api: GhClient, repo: string, token: string, secret: string): Promise<Step> {
  const { status, data } = await api.request("GET", `/repos/${repo}/hooks`, { token });
  const hooks = Array.isArray(data) ? data : [];
  if (status === 200 && hooks.some((h) => str(asObject(asObject(h)?.config)?.url) === PR_AGENT_WEBHOOK_URL)) {
    return { ok: false, line: `⏭️  ${repo}: pr-agent webhook already present` };
  }

  const created = await api.request("POST", `/repos/${repo}/hooks`, {
    token,
    json: {
      name: "web",
      active: true,
      events: [...WEBHOOK_EVENTS],
      // `secret` is the ONLY field here that is a credential. It goes on the
      // wire and nowhere else: the report line below names the action, never
      // the payload.
      config: { url: PR_AGENT_WEBHOOK_URL, content_type: "json", secret },
    },
  });
  if (created.status === 200 || created.status === 201) {
    return { ok: true, line: `✅ ${repo}: pr-agent webhook created` };
  }
  return { ok: false, line: `⏭️  ${repo}: pr-agent webhook not created (HTTP ${created.status})` };
}

/**
 * Step 2/3 — make sure one repo file matches its template.
 *
 * `GET` the current file, compare decoded bytes, and `PUT` only on a
 * difference:
 *   - 200 and equal → skip. This is the case that keeps a converged fork
 *     silent, and the case a blind `PUT` would destroy.
 *   - 200 and different → `PUT` WITH the `sha` from the GET. GitHub requires it
 *     for an update; without it the write is rejected (409/422).
 *   - 404 → the file does not exist, so there is no sha to send: `PUT` the
 *     template to CREATE it.
 *   - any other status → the file could not be read, so it cannot be compared,
 *     and writing anyway would be an unverifiable overwrite. Report the skip.
 */
async function syncFile(
  api: GhClient,
  repo: string,
  path: string,
  body: string,
  token: string,
): Promise<Step> {
  const apiPath = `/repos/${repo}/contents/${path}`;
  const current = await api.request("GET", apiPath, { token });

  if (current.status === 200) {
    if (decodeContent(current.data) === body) {
      return { ok: false, line: `⏭️  ${repo}: \`${path}\` already in sync` };
    }
    const sha = str(asObject(current.data)?.sha);
    const written = await api.request("PUT", apiPath, {
      token,
      json: {
        message: `chore(deps): sync \`${path}\` from the ops template`,
        content: Buffer.from(body, "utf8").toString("base64"),
        // The sha is what makes this an UPDATE rather than a create. Absent, the
        // write is rejected outright. `branch` is deliberately omitted: the
        // contents GET does not return a `default_branch`, so any value here
        // would be a guess, and a wrong branch is a 422.
        sha,
      },
    });
    if (written.status === 200 || written.status === 201) {
      return { ok: true, line: `✅ ${repo}: \`${path}\` updated` };
    }
    return { ok: false, line: `⏭️  ${repo}: \`${path}\` not updated (HTTP ${written.status})` };
  }

  if (current.status === 404) {
    const created = await api.request("PUT", apiPath, {
      token,
      json: {
        message: `chore(deps): add \`${path}\` from the ops template`,
        content: Buffer.from(body, "utf8").toString("base64"),
        // No `sha`: the file does not exist, so this is a create. Sending an
        // empty sha would be read as "update the empty blob" and rejected.
      },
    });
    if (created.status === 200 || created.status === 201) {
      return { ok: true, line: `✅ ${repo}: \`${path}\` created` };
    }
    return { ok: false, line: `⏭️  ${repo}: \`${path}\` not created (HTTP ${created.status})` };
  }

  return { ok: false, line: `⏭️  ${repo}: \`${path}\` unreadable (HTTP ${current.status}) — left alone` };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * The daily run: list the forks, then per fork sync the webhook and the two
 * Dependabot files, and return the operator summary.
 *
 * NEVER THROWS. A cron job that dies leaves the fleet unconfigured with no
 * record of why, which is the failure mode this module exists to prevent; a
 * thrown error becomes one `⚠️` line and the other repos still get their work
 * done. The summary is returned, not posted — Task 17 owns the cron wiring and
 * the `postDiscordOps` call.
 *
 * `deps` IS OPTIONAL and everything it would supply is resolved HERE, at call
 * time: the client, the PAT, the secret, the repo list, the templates.
 */
export async function runSyncHooks(deps: SyncHooksDeps = {}): Promise<SyncSummary> {
  const lines: string[] = [];
  let ok = 0;
  let skip = 0;
  const record = (step: Step) => {
    if (step.ok) ok += 1;
    else skip += 1;
    lines.push(step.line);
  };

  try {
    // CALL TIME, not import time. `deps` wins so a test — and the production
    // wiring — can pin both without touching the process environment.
    const secret = deps.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
    // An empty key is a valid-looking `GitHubApi` that would throw on its first
    // signed call, so the client is built with a deliberately blank key and the
    // token is checked here instead. Every request below carries `token`, so
    // that key is never used.
    const api = deps.api ?? new GitHubApi({ appId: "0", privateKeyPem: "" });
    const token = deps.ghToken ?? api.fetchGhToken?.() ?? "";

    if (!token) {
      // No credential means no work, and the only honest thing to report is
      // why. No request is attempted.
      return { ok: 0, skip: 0, lines: ["⚠️  sync-hooks: no GitHub token available — nothing synced"] };
    }

    let repos = deps.repos;
    if (!repos) {
      const { status, data } = await api.request("GET", REPO_LIST_PATH, { token });
      // A failed listing is NOT an empty fleet: reporting "0 synced" for a
      // transport failure would read as a healthy run.
      if (status !== 200 || !Array.isArray(data)) {
        return { ok: 0, skip: 0, lines: [`⚠️  sync-hooks: repo listing failed (HTTP ${status})`] };
      }
      repos = data.map((r) => str(r?.full_name)).filter((name) => name.length > 0);
    }

    for (const repo of repos) {
      // INVARIANT 3: the guard is HERE, before the hook listing, so a missing
      // secret issues no request against the hooks endpoint at all — not the
      // POST, and not the GET that would decide whether to POST.
      if (secret) {
        record(await syncHook(api, repo, token, secret));
      }

      record(
        await syncFile(api, repo, dependabotPathFor(repo), templateBody(dependabotFileFor(repo)), token),
      );
      // The auto-merge config goes to EVERY repo, GMW included. Read that twice:
      // the gmw Dependabot variant is GMW-only, the auto-merge file is not.
      record(await syncFile(api, repo, AUTO_MERGE_PATH, templateBody(AUTO_MERGE_FILE), token));
    }

    return { ok, skip, lines };
  } catch (err) {
    // The templates are the one thing that can be structurally missing, and the
    // message names the cause instead of surfacing a bare ENOENT from deep
    // inside `readFileSync`.
    const name = err instanceof Error ? err.name : typeof err;
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`⚠️  sync-hooks: ${name}: ${msg}`);
    skip += 1;
    return { ok, skip, lines };
  }
}

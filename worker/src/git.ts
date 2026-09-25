/**
 * Git process helpers — port of `scripts/pr-queue-worker.py` lines 1055-1066
 * (`_sync_git`), 1130-1140 (`_sync_push_urls`), 1152-1173 (the two push-error
 * markers and classifiers), 1176-1191 (`_push_ref`), plus the two clone sites
 * at lines 648 and 840 and the bot-identity `git config` pair at 655-656 /
 * 847-848.
 *
 * Two contract points dominate the design:
 *
 * 1. `runGit` NEVER THROWS. A cron tick must degrade, not crash, and the
 *    Python encodes that as a value: timeouts become exit 124 and a missing
 *    `git` becomes 127. Bun's `spawnSync` is NOT that safe — it THROWS an
 *    ENOENT for a missing binary, reports a timeout as `exitCode: null` with
 *    `signalCode: "SIGTERM"`, and uses the same `exitCode: null` for a process
 *    killed by an external signal. Every one of those is mapped back to the
 *    Python's numeric code below, and the whole call sits in a try/catch so an
 *    unforeseen spawn failure also degrades to a result.
 *
 * 2. `pushRef` must not leak a credential. A push/clone argv carries the token
 *    in the URL's userinfo, and a synthesized timeout message echoes that argv,
 *    so every string that can reach `detail` is redacted first. git's own
 *    stderr never echoes the URL, so the ordinary path was already safe.
 */
/** Python `_sync_git(..., timeout=180)` (line 1055) — the default budget. */
const DEFAULT_TIMEOUT_SEC = 180;
/** Python `subprocess.run(..., timeout=10)` for the `git config` pair (line 655). */
const IDENTITY_TIMEOUT_SEC = 10;
/** Python `_sync_git([...], workdir, 300)` for push (line 1181). */
const PUSH_TIMEOUT_SEC = 300;
/** Python `subprocess.run([... "clone" ...], timeout=60)` (lines 648, 840). */
const CLONE_TIMEOUT_SEC = 60;
/** Python `err[-260:]` (line 1185) — the detail keeps only the error's tail. */
const DETAIL_TAIL = 260;

/** Python's `subprocess.CompletedProcess`, reduced to the three fields used. */
export type GitResult = { code: number; stdout: string; stderr: string };

/**
 * Strip credential userinfo out of anything that will be reported.
 *
 * The Python's timeout message interpolates the full argv, and a push/clone
 * argv contains `https://x-access-token:<token>@github.com/…`. That string
 * reaches `pushRef().detail`, which the sync reporter posts to a Discord
 * channel (py:1447 → 1492-1497) — so a 300s push timeout on both credentials
 * would print the App installation token in public. The Python inherited this
 * leak; the port does not.
 *
 * Redaction is deliberately narrow: only the userinfo of an http(s) URL is
 * rewritten, so an ordinary git error mentioning a repository path survives
 * intact and stays diagnosable.
 */
export function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@");
}

/**
 * Python's `err[-260:]` — the last 260 CODE POINTS.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a 4-byte emoji
 * straddling the boundary would be cut in half and render as U+FFFD, and the
 * tail would come up one code point short. Spreading iterates code points.
 */
export function tail(text: string, n: number): string {
  const points = [...text];
  return points.length <= n ? text : points.slice(-n).join("");
}

/** Injection seam so push/clone decision logic is testable without real git. */
export type GitRunner = (
  args: string[],
  cwd?: string,
  timeoutSec?: number,
) => GitResult;

/**
 * Python `_sync_git(args, cwd=None, timeout=180)` (lines 1055-1066).
 *
 * "Run git, never raising: timeouts become exit 124, missing git exit 127."
 * BUN MAPPING (probed on Bun 1.3.14, not assumed):
 *   - timeout   → `exitCode: null`, `signalCode: "SIGTERM"`, `exitedDueToTimeout: true`
 *   - self-kill → `exitCode: null`, `signalCode: "SIGKILL"`, `exitedDueToTimeout: undefined`
 *   - ENOENT    → spawnSync THROWS a Node-style ENOENT
 * The timeout is therefore keyed off the explicit `exitedDueToTimeout` flag
 * rather than `exitCode === null`, which cannot tell a timeout from a signal
 * kill. (A leftover `null` below means the signal-kill case, not the timeout.)
 */
export const runGit: GitRunner = (args, cwd, timeoutSec = DEFAULT_TIMEOUT_SEC) => {
  const cmd = ["git", ...args.map((a) => String(a))];
  try {
    const r = Bun.spawnSync({
      cmd,
      cwd: cwd ? String(cwd) : undefined,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutSec * 1000,
    });
    if (r.exitedDueToTimeout) {
      // Python line 1064: CompletedProcess(cmd, 124, "", f"timeout after {timeout}s: {exc}").
      // The exception text is unavailable here, so the message keeps the part
      // that identifies the failure — the budget it blew past. Python also
      // discards whatever the child had already written (stdout is the literal
      // "" there), so partial output is dropped rather than reported: a
      // half-finished push transcript is not a result anyone can act on.
      return {
        code: 124,
        stdout: "",
        stderr: redactCredentials(`timeout after ${timeoutSec}s: git ${args.join(" ")}`),
      };
    }
    // `null` here means a signal kill we did not ask for; git never reports
    // one on its own, so surface it as a failure rather than a bogus success.
    return {
      code: r.exitCode ?? 1,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  } catch (err) {
    // Python line 1065: FileNotFoundError → 127. Any OTHER spawn failure lands
    // in the same bucket: a tick must not die because the process table is
    // momentarily exhausted, and a non-zero code makes every caller treat the
    // result as a failure.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { code: 127, stdout: "", stderr: "git not found" };
    }
    return {
      code: 127,
      stdout: "",
      stderr: `git spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

/** Which credential a push URL carries. */
export type PushCredential = { url: string; kind: "pat" | "app" };

/** The x-access-token URL form shared by every push/fetch/clone in the Python. */
const credentialUrl = (token: string, repo: string): string =>
  `https://x-access-token:${token}@github.com/${repo}.git`;

/**
 * Python `_sync_push_urls(fork, app_token)` (lines 1130-1140).
 *
 * "Push credentials, best first. The owner PAT comes first on purpose: the
 * App lacks `workflows` permission, so a merge touching .github/workflows/*
 * (very common when syncing) is rejected for the App token."
 *
 * DIVERGENCE, deliberate and brief-mandated: the Python calls `_fetch_gh_token()`
 * itself (line 1135). Here the PAT is a parameter, so the CALLER injects it —
 * `GitHubApi.fetchGhToken()` (worker/src/github.ts) is that call. Keeping the
 * `gh` CLI out of this module is what lets every push test run with a stub.
 * A missing gh CLI is exactly the case where the list holds the App token only.
 */
export function pushUrls(fork: string, appToken: string, pat: string): PushCredential[] {
  const urls: PushCredential[] = [];
  if (pat) urls.push({ url: credentialUrl(pat, fork), kind: "pat" });
  if (appToken) urls.push({ url: credentialUrl(appToken, fork), kind: "app" });
  return urls;
}

// Marker lists transcribed VERBATIM from Python lines 1152-1163, in order.
// Do not sort, dedupe, or "tidy" these: the App-token path and the
// PR-Auto-Sync path match on these exact substrings. Note the literal
// BACKTICK in "workflows` permission" — that is the Python's own typo and is
// load-bearing, because GitHub's real message is "`workflows` permission".
const PROTECTED_PUSH_MARKERS = [
  "protected branch",
  "gh006",
  "required status check",
  "branch protection",
  "protected_branch",
] as const;

const WORKFLOW_PUSH_MARKERS = [
  "workflows permission",
  "workflows` permission", // literal backtick after the s — see above
  "create or update workflow",
] as const;

/** Python `_is_protected_push_error` (lines 1166-1168). Raw input, lowercased here. */
export function isProtectedPushError(err: string): boolean {
  if (!err) return false;
  const low = err.toLowerCase();
  return PROTECTED_PUSH_MARKERS.some((m) => low.includes(m));
}

/** Python `_is_workflow_push_error` (lines 1171-1173). */
export function isWorkflowPushError(err: string): boolean {
  if (!err) return false;
  const low = err.toLowerCase();
  return WORKFLOW_PUSH_MARKERS.some((m) => low.includes(m));
}

/** Python `_push_ref`'s `(ok, detail, protected)` triple, as an object. */
export type PushRefResult = { ok: boolean; detail: string; protected: boolean };

export type PushRefOpts = {
  /** Injected PAT; `""` mirrors an unavailable `gh auth token`. */
  pat: string;
  run?: GitRunner;
};

/**
 * Python `_push_ref(workdir, fork, source, dest, app_token, force=False)`
 * (lines 1176-1191). Push `source` to `dest` on the fork.
 *
 * The stop-immediately semantics ARE the point of the PAT-first ordering:
 * a protected branch is protected for BOTH credentials, and an App token can
 * never push a workflow change. Only an unclassified error (a transient reset,
 * a stale credential) is worth retrying with the other credential, so that is
 * the only case that advances the loop.
 */
export function pushRef(
  workdir: string,
  fork: string,
  source: string,
  dest: string,
  appToken: string,
  force = false,
  opts: PushRefOpts,
): PushRefResult {
  const refspec = (force ? "+" : "") + `${source}:${dest}`;
  let last = "no push credentials available";
  for (const { url, kind } of pushUrls(fork, appToken, opts.pat)) {
    const r = (opts.run ?? runGit)(["push", url, refspec], workdir, PUSH_TIMEOUT_SEC);
    if (r.code === 0) {
      return { ok: true, detail: `${kind} push ok`, protected: false };
    }
    // Python line 1184: stderr AND stdout concatenated.
    const err = (r.stderr || "").concat(r.stdout || "").trim();
    // Python line 1185. `err[-260:]` slices by CODE POINT, so the tail is taken
    // with a spread rather than `String.slice` (UTF-16 units — a boundary
    // emoji would leave a lone surrogate). The URL — and therefore the token —
    // is redacted as well: the timeout message echoes argv, and a redaction
    // gap would put the credential into this string, which reaches Discord.
    last = `${kind}: ${tail(redactCredentials(err), DETAIL_TAIL)}`;
    if (isProtectedPushError(err)) {
      return { ok: false, detail: last, protected: true };
    }
    if (isWorkflowPushError(err)) {
      // PAT missing/insufficient: the App cannot push workflow changes.
      return {
        ok: false,
        detail: `needs the \`workflows\` App permission or the gh PAT (${last})`,
        protected: false,
      };
    }
  }
  return { ok: false, detail: last, protected: false };
}

export type CloneOpts = { run?: GitRunner };

/**
 * The two clone sites, unified — Python lines 647-656 (lockfix, `--depth 5`)
 * and 839-848 (AI-fix, `--depth 20`).
 *
 * `depth` is a real parameter because the two sites genuinely differ; the
 * default is the AI-fix path's 20, and the lockfix caller passes 5.
 *
 * The flag order is kept exactly as the Python writes it — `clone`, url, dir,
 * THEN `--branch`/`--depth` (lines 648, 840). That is legal git (options may
 * follow positional operands) and keeps the command line byte-comparable with
 * the source of truth.
 *
 * The bot identity is set in the CLONED workdir, because both Python sites
 * write it with `cwd=workdir` AFTER a successful clone.
 */
export function cloneForPr(
  repo: string,
  branch: string,
  token: string,
  workdir: string,
  depth = 20,
  opts: CloneOpts = {},
): boolean {
  const run = opts.run ?? runGit;
  const r = run(
    ["clone", credentialUrl(token, repo), workdir, "--branch", branch, "--depth", String(depth)],
    undefined,
    CLONE_TIMEOUT_SEC,
  );
  if (r.code !== 0) return false;
  setBotIdentity(workdir, run);
  return true;
}

/**
 * `git config user.name` + `user.email` in `workdir` — Python lines 655-656 and
 * 847-848. Each with its own 10s budget; return values are ignored in the
 * Python and so are ignored here (a tick is not worth failing over a name).
 */
export function setBotIdentity(workdir: string, run: GitRunner = runGit): void {
  run(["config", "user.name", "mytheclipsebotreview"], workdir, IDENTITY_TIMEOUT_SEC);
  run(["config", "user.email", "bot@users.noreply.github.com"], workdir, IDENTITY_TIMEOUT_SEC);
}

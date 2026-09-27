/**
 * The sync flow's type surface: what a sync can report, what it needs, and the
 * injection points that keep every external effect out of module scope.
 *
 * Extracted verbatim from `run.ts` so that file comes back under the 400-line
 * cap. THIS IS A MOVE, NOT A REWRITE — every field, comment and union member is
 * byte-identical, including the long note on why `report` is REQUIRED. That note
 * is load-bearing history: `report?` being optional made `deps.report?.push(...)`
 * a silent no-op at all three buffered sites, and nothing in `worker/src` ever
 * constructed a port, so the salvage line could never reach an operator. A
 * required port fails at wiring time instead, which is how it was caught.
 *
 * `run.ts` re-exports everything here, so every existing `from "./run"` import
 * site keeps working unchanged. That is deliberate: these types belong to the
 * sync flow as a whole, not to one file, and eleven modules plus the test suite
 * import them from `./run`. Re-exporting means this move touched no caller.
 */
import type { GitRunner } from "../git";
import type { Workdirs } from "../pr/lockfix";
import type { GhAppClient } from "../pr/scan";
import type { PostResult } from "../agent";
import type { RepoOverrides, SyncConfig, SyncState } from "./config";

/**
 * The Python's `return "synced", ""` pairs. The brief names this union exactly,
 * and every value is a REPORTED outcome — `runUpstreamSync` switches on it to
 * pick the report line, the Discord post and whether the budget is spent.
 */
export type SyncStatus =
  | "synced"
  | "pr-opened"
  | "conflict-failed"
  | "push-failed"
  | "error"
  | "dry"
  | "pr-path";

/** Python's `(status, detail)`. */
export type SyncResult = [SyncStatus, string];

/** One fork's sync inputs — the Python's seven positional parameters. */
export interface SyncRequest {
  fork: string;
  /** The installation token: clones, pushes and API calls for the FORK. */
  token: string;
  /** The upstream's `owner/repo`. */
  parent: string;
  localBranch: string;
  upstreamBranch: string;
  /** The upstream tip sha being merged. */
  upstreamSha: string;
  /** Upstream commits the fork lacks (compare `ahead_by`). */
  mergeCount: number;
  /** Fork-only commits (compare `behind_by`) — reported, never discarded. */
  divergence: number;
}

/**
 * The buffered run report. `Report` (report.ts) satisfies this structurally,
 * and so does any `{ push(line) }` — the port stays structural so a sync module
 * never imports a filesystem- or global-state-bearing report module at module
 * scope. The Python's `BUFFER` is module-global; this is the injection point
 * that keeps the same behaviour testable.
 */
export type ReportPort = { push(line: string): void };

/** `AgentClient` satisfies this structurally. */
export type SyncAgentPort = {
  runSync(opts: {
    workdir: string;
    prompt: string;
    label: string;
    fork: string;
    dry?: boolean;
  }): Promise<PostResult>;
};

/** Python `post_sync_discord(title, lines, color=0x5865F2)`. */
export type PostDiscord = (title: string, lines: string[], color?: number) => Promise<boolean>;

/** Everything `syncForkRepo` needs. Nothing is read from module scope. */
export type SyncForkDeps = {
  run: GitRunner;
  workdirs: Workdirs;
  agent: SyncAgentPort;
  api: GhAppClient;
  /** Python `_fetch_gh_token()` — the PAT push tries FIRST. */
  fetchGhToken: () => string;
  postDiscord: PostDiscord;
  loadState: () => SyncState;
  saveState: (state: SyncState) => void;
  /** Python `time.time()`. */
  now: () => number;
  /**
   * REQUIRED, and this is the whole point. The three BUFFER lines below — the
   * resolving line, the SALVAGE line and the quality line — are the operator's
   * only record that a merge was recovered from an agent call that ended early,
   * and the following push looks like any other push. With `report?` optional,
   * `deps.report?.push(...)` was a silent no-op at every one of those sites and
   * nothing in `worker/src` ever constructed a port, so the salvage line could
   * never reach a report. A required port fails at WIRING time instead, which
   * is what caught it here.
   */
  report: ReportPort;
};

/** Everything `runUpstreamSync` needs on top of the fork flow. */
export type RunUpstreamSyncDeps = SyncForkDeps & {
  /** Per-repo overrides, passed in rather than read from a singleton. */
  repoOverrides: RepoOverrides;
  /**
   * The real `syncForkRepo`. A parameter so the gating test can observe the
   * attempts without running a clone — the Python replaced the module global
   * for the same reason.
   */
  syncForkRepo?: (
    deps: SyncForkDeps,
    req: SyncRequest,
    state: SyncState,
    cfg: SyncConfig,
    dry?: boolean,
  ) => Promise<SyncResult>;
};

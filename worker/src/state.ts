/**
 * Fix-state / sync-state JSON — port of `scripts/pr-queue-worker.py`
 * lines 236-298 (fix state) and 1006-1022 (sync state).
 *
 * CUT-OVER CONTRACT (Task 17): these files survive the Python→TS switch, so the
 * on-disk bytes must stay compatible with the Python reader. Two files, two
 * different serializers — deliberately NOT unified:
 *   - fix state  → `JSON.stringify(state)`, compact, no indent (Python line 249)
 *   - sync state → `JSON.stringify(state, null, 1)`, indent=1 (Python line 1020)
 * Repo keys are full `owner/repo` names; PR keys are STRINGIFIED numbers.
 *
 * SAVE SEMANTICS: the Python mutators (`mark_fixed`, `mark_skip`,
 * `mark_skip_notified`) persist as a side effect. Here they are PURE mutations
 * and the caller must call `saveFixState(file, state)` — the brief's spec calls
 * them with no file argument (`markFixed(s, "o/r", 1, "sha9")`). A later task
 * that drives these mutators MUST save; see task-8-report.md.
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Python `FIX_STATE_FILE` (line 66) — the canonical path for `saveFixState`. */
export const FIX_STATE_FILE = "/tmp/pr-queue-fix-state.json";
/** Python `SYNC_STATE_FILE` (line 985). */
export const SYNC_STATE_FILE = "/tmp/pr-queue-sync-state.json";

/** Per-PR record. `skip_reason` is absent (not null) when there is no skip. */
export interface PrEntry {
  sha?: string;
  skip_reason?: string;
  notified?: boolean;
  [key: string]: unknown;
}

/** `{ "owner/repo": { "<pr>": PrEntry } }` */
export type FixState = Record<string, Record<string, PrEntry>>;

/**
 * Sync bookkeeping per fork. The field set belongs to the sync task, which is
 * not ported yet, so the entry stays opaque rather than speculative.
 */
export type SyncState = Record<string, Record<string, unknown>>;

/** Read a JSON file, falling back when it is missing, unreadable or corrupt. */
function readJsonTolerant<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function loadFixState(file: string = FIX_STATE_FILE): FixState {
  return readJsonTolerant<FixState>(file, {});
}

/** Compact, no indent — byte-compatible with Python's `json.dumps(state)`. */
export function saveFixState(file: string, state: FixState): void {
  writeFileSync(file, JSON.stringify(state));
}

export function loadSyncState(file: string = SYNC_STATE_FILE): SyncState {
  return readJsonTolerant<SyncState>(file, {});
}

/** indent=1, mirroring Python's `json.dumps(state, indent=1)`. OSError is swallowed. */
export function saveSyncState(file: string, state: SyncState): void {
  try {
    writeFileSync(file, JSON.stringify(state, null, 1));
  } catch {
    /* Python: `except OSError: pass` */
  }
}

/**
 * Get the per-PR entry, creating it if absent, and migrate the legacy format
 * `{repo: {pr: "sha"}}` (bare string) to the dict form IN PLACE. Python
 * `_pr_entry`, lines 251-259.
 */
export function prEntry(state: FixState, repo: string, pr: number | string): PrEntry {
  const repoState: Record<string, unknown> = state[repo] ?? (state[repo] = {});
  const key = String(pr);
  const existing = repoState[key];
  if (typeof existing === "string") {
    // legacy: {"pr": "sha"} → {"sha": "sha", "notified": false} (no skip_reason)
    repoState[key] = { sha: existing, notified: false };
  } else if (existing === undefined) {
    repoState[key] = {};
  }
  return repoState[key] as PrEntry;
}

/** True if this PR was already fixed (or permanently skipped) at this SHA. */
export function alreadyFixed(
  state: FixState,
  repo: string,
  pr: number | string,
  headSha: string,
): boolean {
  return prEntry(state, repo, pr).sha === headSha;
}

/** Mark the PR as fixed at `headSha`. Caller must `saveFixState`. */
export function markFixed(
  state: FixState,
  repo: string,
  pr: number | string,
  headSha: string,
): PrEntry {
  const entry = prEntry(state, repo, pr);
  entry.sha = headSha;
  delete entry.skip_reason;
  entry.notified = false;
  return entry;
}

/** The permanent skip reason for this PR+SHA, or undefined for any other SHA. */
export function getSkipReason(
  state: FixState,
  repo: string,
  pr: number | string,
  headSha: string,
): string | undefined {
  const entry = prEntry(state, repo, pr);
  return entry.sha === headSha ? entry.skip_reason : undefined;
}

/** Permanently skip AI-fix/merge for this PR at this SHA. Caller must `saveFixState`. */
export function markSkip(
  state: FixState,
  repo: string,
  pr: number | string,
  headSha: string,
  reason: string,
): PrEntry {
  const entry = prEntry(state, repo, pr);
  entry.sha = headSha;
  entry.skip_reason = reason;
  return entry;
}

/** True if the skip notification for this PR+SHA was already sent. */
export function wasSkipNotified(
  state: FixState,
  repo: string,
  pr: number | string,
  headSha: string,
): boolean {
  const entry = prEntry(state, repo, pr);
  return Boolean(entry.notified) && entry.sha === headSha;
}

/** Record that the skip notification went out. Caller must `saveFixState`. */
export function markSkipNotified(
  state: FixState,
  repo: string,
  pr: number | string,
  headSha: string,
): PrEntry {
  const entry = prEntry(state, repo, pr);
  entry.notified = true;
  return entry;
}

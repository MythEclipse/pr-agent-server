// The disk does not fail loudly, and that is the whole reason this exists.
//
// MEASURED on the box: `/` was 103G of 116G — 90% — with 13G left. The worker
// clones a repo into `/tmp/pr-queue-work` for every unit of work, and the pnpm
// store and cargo registry grow alongside it. Nothing pruned either. At 100% the
// failure is not "a review failed": the API cannot write its queue, the deploy
// job cannot unpack a tarball, and the service that would tell you about it is
// the one that is down.
//
// So the guard does three things, cheapest first:
//   1. MEASURE — one `statfs`, no writes.
//   2. REAP — delete workdirs this worker created and nobody is using any more.
//      Only names this project owns (`_vuln_`, `pr-queue-`) and only directories
//      older than the age floor, so an in-flight run cannot lose its tree.
//   3. PRUNE CACHES — `pnpm store prune` (safe by design: it only drops packages
//      no lockfile references) and cargo's registry cache.
//
// If it is STILL above the hard limit after that, the caller refuses to start
// rather than fill the last gigabytes: a skipped run is recoverable, a full disk
// is an outage.

import { readdirSync, rmSync, statfsSync, statSync } from "node:fs"

/** What the guard needs from the filesystem and the process runner. */
export type DiskGuardDeps = {
	/** Bytes free and total for a path. */
	usage: (path: string) => { freeBytes: number; totalBytes: number }
	/** Names inside a directory, or [] when it does not exist. */
	list: (path: string) => { name: string; isDirectory: boolean; mtimeMs: number }[]
	/** Remove a directory tree. */
	remove: (path: string) => void
	/** Run a cache-pruning command; returns whether it exited 0. */
	prune: (argv: string[]) => { code: number }
	now: () => number
	log: (line: string) => void
}

export type DiskGuardOptions = {
	/** Where the worker's clones live. */
	base: string
	/**
	 * Used-space percentage that triggers the reaper. 85 leaves room to work.
	 */
	reapAtPct?: number
	/**
	 * Used-space percentage above which the caller must NOT start new work.
	 */
	refuseAtPct?: number
	/** Workdirs younger than this are left alone — they may be in flight. */
	maxAgeMs?: number
	/** Only names starting with one of these are ever removed. */
	ownedPrefixes?: readonly string[]
	/** Skip the cache prune (tests, or a box where it is not installed). */
	pruneCaches?: boolean
}

export type DiskGuardResult = {
	usedPctBefore: number
	usedPctAfter: number
	removed: number
	freedBytes: number
	pruned: string[]
	/** True when the caller must refuse to start new work. */
	refuse: boolean
}

/** Bytes → a short human string, because `13.4G` is what an operator reads. */
export function formatBytes(bytes: number): string {
	const units = ["B", "K", "M", "G", "T"]
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit += 1
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}

/**
 * Reap workdirs this project created that nobody is using any more.
 *
 * AGE FLOOR, NOT "everything but the newest": two runs can overlap (the 5-minute
 * tick and the nightly fixer take different locks only by convention), and a
 * directory mtime is touched when the clone is written, not when the run ends.
 * Six hours is far longer than any review or fix run takes and far shorter than
 * the disk filling up.
 */
export function reapWorkdirs(
	deps: Pick<DiskGuardDeps, "list" | "remove" | "now" | "log">,
	opts: Required<Pick<DiskGuardOptions, "base" | "maxAgeMs" | "ownedPrefixes">>,
): { removed: number; freedBytes: number } {
	const cutoff = deps.now() - opts.maxAgeMs
	let removed = 0
	const freedBytes = 0

	for (const entry of deps.list(opts.base)) {
		if (!entry.isDirectory) continue
		if (!opts.ownedPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue
		if (entry.mtimeMs > cutoff) continue
		try {
			deps.remove(`${opts.base}/${entry.name}`)
			removed += 1
			// The size is not measured: walking a tree to report bytes costs the same
			// I/O the delete is trying to free, and the number an operator needs is
			// the free space AFTER, which is measured directly below.
		} catch (err) {
			deps.log(`   ⚠️ could not remove ${entry.name}: ${(err as Error).message}`)
		}
	}
	return { removed, freedBytes }
}

/**
 * Run the guard. Returns what happened; the CALLER decides what a refusal means
 * for its own work (the fixer reports and exits 0, the tick exits non-zero so
 * systemd notices).
 */
export function guardDisk(deps: DiskGuardDeps, opts: DiskGuardOptions): DiskGuardResult {
	const reapAtPct = opts.reapAtPct ?? 85
	const refuseAtPct = opts.refuseAtPct ?? 95
	const maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60 * 1000
	const ownedPrefixes = opts.ownedPrefixes ?? ["_vuln_", "pr-queue-"]

	const pct = (u: { freeBytes: number; totalBytes: number }): number =>
		u.totalBytes === 0 ? 0 : Math.round(((u.totalBytes - u.freeBytes) / u.totalBytes) * 100)

	const before = deps.usage(opts.base)
	const usedPctBefore = pct(before)
	let removed = 0
	let freedBytes = 0
	const pruned: string[] = []

	if (usedPctBefore >= reapAtPct) {
		deps.log(
			`disk: ${usedPctBefore}% used (${formatBytes(before.freeBytes)} free) — reaping workdirs older than ${Math.round(maxAgeMs / 3_600_000)}h`,
		)
		const reaped = reapWorkdirs(deps, { base: opts.base, maxAgeMs, ownedPrefixes })
		removed = reaped.removed
		freedBytes = reaped.freedBytes
		if (removed > 0) deps.log(`disk: removed ${removed} stale workdir(s)`)

		// Caches only once the cheap reaping has not been enough: pruning them
		// costs a re-download on the next run, so it is the second resort.
		if (opts.pruneCaches !== false && pct(deps.usage(opts.base)) >= reapAtPct) {
			for (const argv of [
				["pnpm", "store", "prune"],
				["cargo", "cache", "clean"],
			]) {
				const res = deps.prune(argv)
				if (res.code === 0) pruned.push(argv.join(" "))
			}
		}
	}

	const after = deps.usage(opts.base)
	const usedPctAfter = pct(after)
	const refuse = usedPctAfter >= refuseAtPct
	if (refuse) {
		deps.log(
			`disk: STILL ${usedPctAfter}% used (${formatBytes(after.freeBytes)} free) after cleanup — refusing to start new work`,
		)
	}
	return { usedPctBefore, usedPctAfter, removed, freedBytes, pruned, refuse }
}

/** The real dependencies. Kept here so callers cannot drift from the guard. */
export function nodeDiskDeps(
	exec: (argv: string[]) => { code: number },
	log: (line: string) => void,
): DiskGuardDeps {
	return {
		usage: (path) => {
			const s = statfsSync(path)
			return {
				freeBytes: Number(s.bavail) * Number(s.bsize),
				totalBytes: Number(s.blocks) * Number(s.bsize),
			}
		},
		list: (path) => {
			try {
				return readdirSync(path, { withFileTypes: true }).map((d) => {
					// `statSync`, not `statfsSync`: the guard needs the DIRECTORY's mtime,
					// and `statfs` reports the filesystem's, which never moves.
					let mtimeMs = 0
					try {
						mtimeMs = statSync(`${path}/${d.name}`).mtimeMs
					} catch {
						// A directory removed between the readdir and the stat is not an
						// error worth reporting: it is the reaper's own work.
					}
					return { name: d.name, isDirectory: d.isDirectory(), mtimeMs }
				})
			} catch {
				return []
			}
		},
		remove: (path) => rmSync(path, { recursive: true, force: true }),
		prune: exec,
		now: () => Date.now(),
		log,
	}
}

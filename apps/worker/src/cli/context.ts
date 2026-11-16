import type { WorkerDeps } from "../pr/pipeline.ts"
import type { Report } from "../report.ts"

/** Runtime collaborators shared by the CLI modes; configuration stays in the entry point. */
export interface WorkerCliContext {
	buildDeps(opts: { dry: boolean; report: Report }): WorkerDeps
	webhookSecret: string
	/** Register the active lock so the entry point can release it on SIGTERM. */
	setReleaseHeld(release: (() => void) | null): void
}

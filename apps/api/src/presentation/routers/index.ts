// Router composition (skill §2.5). Export type AppRouter — the web app
// imports this type only, never a runtime symbol.

import { z } from "zod"
import { adminProcedure, protectedProcedure } from "../orpc/middleware.ts"

// There is deliberately NO `health.check` procedure here.
//
// It used to be one — `publicProcedure.handler(() => ({ status: "ok", model:
// "configured" }))` — and it was wrong in three ways at once. It answered
// `model: "configured"`, a literal that never reflected the configured model; a
// probe reading it would conclude the API was healthy no matter what
// PR_AGENT_MODEL_REVIEW said. It was a SECOND liveness answer next to the real
// one at `GET /health`, which reports the actual `cfg.modelReview` and is what
// the systemd watchdog and deploy.yml's "Wait for health" step poll. And nothing
// consumed it: not the SPA, not any test, not any ops script.
//
// Two health endpoints that can disagree is worse than one, so the duplicate is
// gone rather than kept in sync. `GET /health` is the single liveness surface.

export function buildRouter() {
	return {
		me: {
			get: protectedProcedure.handler(({ context }) => ({
				userId: context.session?.userId ?? null,
				email: context.session?.email ?? null,
				name: context.session?.name ?? null,
				role: context.session?.role ?? null,
			})),
		},

		review: {
			list: adminProcedure
				.input(
					z
						.object({
							owner: z.string().optional(),
							repo: z.string().optional(),
							pr: z.number().int().positive().optional(),
							status: z.enum(["queued", "running", "success", "failed"]).optional(),
							kind: z.enum(["review", "describe", "improve"]).optional(),
							limit: z.number().int().positive().max(200).optional(),
							offset: z.number().int().min(0).optional(),
						})
						.optional(),
				)
				.handler(({ context, input }) => context.useCases.review.list(input ?? {})),

			get: adminProcedure
				.input(z.object({ id: z.number().int().positive() }))
				.handler(({ context, input }) => context.useCases.review.get(input)),
		},

		queue: {
			stats: adminProcedure.handler(({ context }) => context.queueStore.stats()),
		},
	}
}

export type AppRouter = ReturnType<typeof buildRouter>

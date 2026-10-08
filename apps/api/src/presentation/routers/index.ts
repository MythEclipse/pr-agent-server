// Router composition (skill §2.5). Export type AppRouter — the web app
// imports this type only, never a runtime symbol.

import { z } from "zod"
import type { UseCases } from "../../application/use-cases.ts"
import { adminProcedure, protectedProcedure, publicProcedure } from "../orpc/middleware.ts"

export function buildRouter(useCases: UseCases) {
	void useCases
	return {
		health: {
			check: publicProcedure.handler(() => ({ status: "ok" as const, model: "configured" })),
		},

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

// The single place that knows how an application error becomes a transport
// error (skill §2.5). Nothing else may choose an HTTP status.

import { ORPCError } from "@orpc/client"
import type { AppErrorCode } from "../../application/shared/errors.ts"

const STATUS: Record<AppErrorCode, number> = {
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	BAD_REQUEST: 400,
	CONFLICT: 409,
	INTERNAL_ERROR: 500,
}

export interface TErrorData {
	message: string
}

export type TOrpcError = ORPCError<AppErrorCode, TErrorData>

export function toOrpcError(err: unknown): TOrpcError {
	const code = (err as { code?: string })?.code as AppErrorCode | undefined
	if (code && code in STATUS) {
		return new ORPCError(code, {
			status: STATUS[code],
			data: { message: String((err as Error).message) },
		})
	}
	return new ORPCError("INTERNAL_ERROR", {
		status: 500,
		data: { message: err instanceof Error ? err.message : "unknown error" },
	})
}

// Typed application errors (skill §2.3).
//
// The use-cases throw these instead of ORPCError so the application layer
// stays independent of the transport; presentation/orpc/error-mapping.ts is
// the single place that knows how each code becomes an HTTP status.

export type AppErrorCode =
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "BAD_REQUEST"
	| "CONFLICT"
	| "INTERNAL_ERROR"

export class AppError extends Error {
	readonly code: AppErrorCode

	constructor(code: AppErrorCode, message: string) {
		super(message)
		this.code = code
		this.name = "AppError"
	}
}

export const unauthorized = (message: string): AppError => new AppError("UNAUTHORIZED", message)
export const forbidden = (message: string): AppError => new AppError("FORBIDDEN", message)
export const notFound = (message: string): AppError => new AppError("NOT_FOUND", message)
export const badRequest = (message: string): AppError => new AppError("BAD_REQUEST", message)
export const conflict = (message: string): AppError => new AppError("CONFLICT", message)
export const internalError = (message: string): AppError => new AppError("INTERNAL_ERROR", message)

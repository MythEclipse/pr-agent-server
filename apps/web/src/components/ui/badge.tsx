import type { HTMLAttributes } from "react"
import { cn } from "#/libs/clsx.ts"

type TBadgeTone = "neutral" | "success" | "danger" | "info" | "warning"

const TONES: Record<TBadgeTone, string> = {
	neutral: "bg-slate-100 text-slate-700",
	success: "bg-emerald-100 text-emerald-800",
	danger: "bg-red-100 text-red-800",
	info: "bg-blue-100 text-blue-800",
	warning: "bg-amber-100 text-amber-900",
}

/** Maps a review status onto a tone. Kept here so every view colours it the same. */
export const STATUS_TONE: Record<string, TBadgeTone> = {
	success: "success",
	failed: "danger",
	running: "info",
	queued: "warning",
}

export function Badge({
	tone = "neutral",
	className,
	...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: TBadgeTone }) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
				TONES[tone],
				className,
			)}
			{...props}
		/>
	)
}

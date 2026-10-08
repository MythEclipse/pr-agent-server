import type { InputHTMLAttributes } from "react"
import { cn } from "#/libs/clsx.ts"

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			className={cn(
				"flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400 disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	)
}

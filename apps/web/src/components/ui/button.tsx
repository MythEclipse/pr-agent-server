import type { ButtonHTMLAttributes } from "react"
import { cn } from "#/libs/clsx.ts"

type TVariant = "default" | "outline" | "ghost" | "destructive"

const VARIANTS: Record<TVariant, string> = {
	default: "bg-slate-900 text-white hover:bg-slate-800",
	outline: "border border-slate-300 bg-white hover:bg-slate-50",
	ghost: "hover:bg-slate-100",
	destructive: "bg-red-600 text-white hover:bg-red-500",
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: TVariant
	size?: "sm" | "md" | "lg"
}

export function Button({ variant = "default", size = "md", className, ...props }: ButtonProps) {
	return (
		<button
			className={cn(
				"inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
				size === "sm" && "h-8 px-3 text-sm",
				size === "md" && "h-10 px-4 text-sm",
				size === "lg" && "h-12 px-6 text-base",
				VARIANTS[variant],
				className,
			)}
			{...props}
		/>
	)
}

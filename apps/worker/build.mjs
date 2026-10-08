// Build the worker into dist/. See apps/api/build.mjs for why this is esbuild
// rather than tsc.

import { cp, mkdir, rm } from "node:fs/promises"
import { build } from "esbuild"

const outdir = "dist"

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

await build({
	entryPoints: ["src/index.ts"],
	outdir,
	bundle: true,
	packages: "external",
	platform: "node",
	target: "node24",
	format: "esm",
	sourcemap: true,
	logLevel: "info",
})

// The sync-hooks unit installs workflow templates from src/ops/templates, and
// they are data rather than code, so they ship verbatim.
await cp("src/ops/templates", `${outdir}/ops/templates`, { recursive: true })

console.log("built dist/")

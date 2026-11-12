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
//
// TWO DESTINATIONS, and the second one is the one production reads. `esbuild`
// BUNDLES every module into the single `dist/index.js`, so inside the bundle
// `import.meta.dirname` is `dist/` — not `dist/ops/` where syncHooks.ts lived
// in the source tree. `TEMPLATE_DIR` therefore resolves to `dist/templates`,
// and shipping only `dist/ops/templates` produced a live failure: every fork
// reported `ENOENT ... dist/templates/dependabot.yml` and NOTHING was synced.
// The `ops/templates` copy is kept because it mirrors the source layout and is
// what the unit tests stage against; `templates/` is what the bundle resolves.
await cp("src/ops/templates", `${outdir}/templates`, { recursive: true })
await cp("src/ops/templates", `${outdir}/ops/templates`, { recursive: true })

console.log("built dist/")

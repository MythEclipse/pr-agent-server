// Build the API into dist/.
//
// tsc cannot emit here: the source uses explicit `.ts` extensions in relative
// imports (skill §4, required alongside verbatimModuleSyntax), and
// allowImportingTsExtensions is only legal with noEmit. esbuild resolves those
// specifiers to real .js paths as it bundles, which is exactly what the
// compiled output needs.

import { cp, mkdir, rm } from "node:fs/promises"
import { build } from "esbuild"

const outdir = "dist"

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

await build({
	// `seed.ts` is here because the dashboard has NO default credentials and no
	// signup path (`role` is `input: false`), so this script is the only way an
	// admin can ever exist. It was missing from this list, so `dist/seed.js` was
	// never built and the documented `pnpm db:seed` provisioning step could not
	// run on the box at all — the `user` table was simply empty and every login
	// failed regardless of the password typed. `test/build-entrypoints.test.ts`
	// fails if it is removed again.
	entryPoints: ["src/main.ts", "src/migrate.ts", "src/db/seed.ts"],
	outdir,
	// Bundle: the source carries explicit `.ts` specifiers (skill §4), which
	// Node cannot resolve from dist/ where the files are `.js`. Bundling
	// resolves them at build time. `packages: external` keeps node_modules out
	// of the output so `pnpm deploy --prod` still governs runtime versions.
	bundle: true,
	packages: "external",
	platform: "node",
	target: "node24",
	format: "esm",
	sourcemap: true,
	logLevel: "info",
})

// Migrations are committed SQL, not compiled output, but dist/migrate.js reads
// them from ./drizzle relative to its own directory.
await cp("drizzle", `${outdir}/drizzle`, { recursive: true })

console.log("built dist/")

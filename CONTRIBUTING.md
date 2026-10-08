# Contributing to PR-Agent Server

## Development Workflow

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make changes — keep files organized in the monorepo layout:
   - `apps/api/` for the webhook server (`apps/api/src/` hexagonal:
     `domain/` → `application/` → `infrastructure/` → `presentation/`; tests in `apps/api/test/`)
   - `apps/worker/` for the PR auto-merge worker
   - `apps/web/` for the review-history dashboard
   - `scripts/` for setup/deployment helpers
   - `deploy/` for the systemd units
4. Verify before committing:
   ```bash
   pnpm exec biome check .
   moon run :typecheck
   moon run :test
   ```
5. Commit with a descriptive message + push
6. Open PR — the server's auto-merge bot will review it

## Standards

- **TypeScript**: `strict: true`; logic files stay ≤ 400 lines; relative imports
  carry an explicit `.ts` extension (required by `verbatimModuleSyntax` +
  `allowImportingTsExtensions`; esbuild resolves them at build time)
- **Runtime**: Node 24+, pnpm 10+, moon for task orchestration. `moon` is a pinned
  root devDependency (`@moonrepo/cli`), so `pnpm install` alone is enough on a fresh
  checkout — no moonup, no global install. Do not rely on a globally installed moon;
  CI resolves it from the lockfile like every other dependency.
- **Secrets**: Always via environment variables or BWS at runtime — never in source
- **Model names**: Must be tested live against 9router before committing (strip the
  `openai/` provider prefix)
- **CI is the gate**: `.github/workflows/ci.yml` runs biome, typecheck, tests, build
  and a Drizzle drift check on every pull request. `deploy.yml` is what ships.
- **The CI runner is a clean slate**: verify with
  `env PATH=/usr/bin:/bin pnpm run typecheck --force` (or `--force` on any moon
  task). A cached moon task is not evidence the command works, and a moonup
  install under `~/.moon/bin` masks a missing dependency. See ci.yml's comment on
  the moon step.

## Testing Checklist

- [ ] `pnpm exec biome check .` reports no errors
- [ ] `moon run :typecheck` reports 0 errors
- [ ] `moon run :test` passes
- [ ] CI `lint + typecheck + test` passes on the PR
- [ ] New models tested live via curl to 9router (not assumed)
- [ ] No secret values in git history (`sk-[a-z0-9]+` patterns)

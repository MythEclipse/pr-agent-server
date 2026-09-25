# Contributing to PR-Agent Server

## Development Workflow

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make changes — keep files organized in the project layout:
   - `server/src/` for the TypeScript server (`server/test/` for `bun:test` suites)
   - `scripts/` for setup/deployment helpers
   - `templates/` for config templates
4. Verify before committing:
   ```bash
   cd server
   bunx tsc --noEmit
   bun test
   ```
5. Commit with a descriptive message + push
6. Open PR — the server's auto-merge bot will review it

## Standards

- **TypeScript**: `strict: true`; logic files stay ≤ 400 lines; relative imports
  without a file extension
- **Runtime**: Bun 1.3.14+ for server and scripts
- **Secrets**: Always via environment variables or BWS at runtime — never in source
- **Model names**: Must be tested live against 9router before committing (strip the
  `openai/` provider prefix)
- **CI is the gate**: `.github/workflows/deploy.yml` runs
  `bun install --frozen-lockfile && bunx tsc --noEmit && bun test` before building
  the single binary

## Testing Checklist

- [ ] `bunx tsc --noEmit` reports 0 errors
- [ ] `bun test` passes
- [ ] CI `typecheck + tests` job passes
- [ ] New models tested live via curl to 9router (not assumed)
- [ ] No secret values in git history (`sk-[a-z0-9]+` patterns)

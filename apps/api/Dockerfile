# syntax=docker/dockerfile:1
#
# PR Agent API — production image.
#
# Build from the REPO ROOT: this is a pnpm workspace (pnpm-workspace.yaml) and
# the apps resolve @pr-agent/* through it, so a context of apps/api would not
# contain them:
#
#   docker build -f apps/api/Dockerfile -t pr-agent-api .
#
# WHY THE RUNTIME CARRIES node_modules
# apps/api/build.mjs bundles with `packages: "external"` — deliberately, so
# `pnpm deploy --prod` still governs runtime versions. The consequence is that
# dist/ cannot resolve any npm package on its own, so the runtime stage installs
# production dependencies rather than copying a build-time tree. Copying the
# builder's node_modules instead would ship devDependencies and the workspace
# links the bundle expects but does not need.
#
# Because the output keeps external specifiers, the runtime needs the SAME
# lockfile the builder verified. `pnpm install --frozen-lockfile` twice is not
# redundant: it is the only thing making the runtime tree match the tested one.

ARG NODE_IMAGE=node:24-slim

# ── builder ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder

ENV CI=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# pnpm is pinned by "packageManager" in the root package.json, so corepack
# resolves the exact version the lockfile was written against. COREPACK_ENABLE_
# DOWNLOAD_PROMPT=0 keeps `corepack enable` non-interactive on a runner with no
# TTY — otherwise the first run prints "Ok to proceed?" and hangs.
WORKDIR /w

RUN corepack enable

# Manifests BEFORE source: this is the layer that makes dependency installs
# cacheable, so editing a .ts file invalidates nothing above it. The list must be
# COMPLETE — every workspace member's package.json is an input to dependency
# resolution, so copying only the root manifest resolves @pr-agent/* against
# nothing.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json    apps/api/
COPY apps/web/package.json    apps/web/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

COPY apps/api/ apps/api/

# Compile to dist/ and copy the committed drizzle/ SQL journal next to it:
# dist/migrate.js reads it from ./drizzle relative to its own directory, so it
# has to travel as a sibling of the compiled entry points.
RUN pnpm --filter @pr-agent/api run build \
 && test -s apps/api/dist/main.js \
 && test -s apps/api/dist/migrate.js \
 && ls apps/api/dist/drizzle/*.sql >/dev/null

# ── runtime ────────────────────────────────────────────────────────────────
# Deliberately does NOT run its own `pnpm install`. It only holds manifests so
# that `pnpm deploy` can resolve the workspace, then copies just /app forward —
# the prod tree that install produced at /w stayed in an intermediate layer and
# was what pushed the image past 1.1GB. `deploy` builds its own resolved tree,
# so a second install is both redundant and the larger of the two.
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    CI=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /w

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json    apps/api/
COPY apps/web/package.json    apps/web/
COPY apps/worker/package.json apps/worker/

# `--prod` because the bundle externalises npm packages and does not need tsc,
# vitest or the vite toolchain.
#
# `--config.node-linker=hoisted` is required, not a preference: pnpm's default
# linker fills node_modules with symlinks into <root>/node_modules/.pnpm, and
# copying that tree without the store leaves every link dangling — which surfaces
# as `Cannot find package 'x'` for a package that is plainly present in the image.
#
# pnpm blocks dependency build scripts unless they are declared, and fails the
# install outright rather than warning (ERR_PNPM_IGNORED_BUILDS). The allow-list
# is `allowBuilds` in pnpm-workspace.yaml — see the comment there for the four
# other places that look right and are not.
RUN pnpm --filter @pr-agent/api deploy --prod --legacy /app

# dist/ has to be copied from the builder BY HAND. `pnpm deploy` packages the
# app's own files, and dist/ is gitignored, so it is skipped — leaving CMD to die
# with `Error [MODULE_NOT_FOUND]` and an empty requireStack, which names neither
# the missing directory nor the .gitignore that caused it.
COPY --from=builder --chown=node:node /w/apps/api/dist/ /app/dist/

RUN test -s /app/dist/main.js \
 && test -s /app/dist/migrate.js \
 && ls /app/dist/drizzle/*.sql >/dev/null

# node (uid 1000) ships in the base image. Nothing in the payload needs root, and
# a world-writable /app is how a container escape becomes a foothold on the host.
# --no-dereference matters: the tree is full of symlinks into .pnpm, and chown
# would otherwise follow them and rewrite ownership of the store too.
RUN chown -R --no-dereference node:node /app
USER node

WORKDIR /app

# 4023 is the port the deploy systemd unit sets. It is written out rather than
# taken from the environment because HEALTHCHECK cannot interpolate ENV.
ENV PORT=4023
EXPOSE 4023

# EXEC form, deliberately. In the shell form (/bin/sh -c "...") every ${...} is
# POSIX parameter expansion performed before node sees the string, so a ${PORT}
# there would expand to the shell's idea of the variable — empty — and the probe
# would silently test nothing. As an argv array there is no shell to expand it.
#
# /health is the real route apps/api mounts. It deliberately does not touch
# Postgres: a liveness probe that fails on a slow database restarts a perfectly
# healthy process, turning a degradation into an outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4023/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# `node` directly, not the base image's docker-entrypoint.sh: no init, no root,
# no wrapper between the container's PID 1 and the service.
CMD ["node", "dist/main.js"]
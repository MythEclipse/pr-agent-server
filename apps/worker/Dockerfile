# syntax=docker/dockerfile:1
#
# PR Agent queue worker — production image.
#
# Build from the REPO ROOT: a pnpm workspace, and the apps resolve @pr-agent/*
# through it, so a context of apps/worker would not contain them.
#
#   docker build -f apps/worker/Dockerfile -t pr-agent-worker .
#
# NO HEALTHCHECK, and that is not an omission. This service is a cron-driven
# queue consumer: it listens on nothing and answers no request, so there is no
# endpoint to probe. Both usual alternatives are worse:
#
#   - a sleep-based "is it alive" probe  → reports a state it cannot observe
#   - `CMD ["true"]` as a healthcheck     → passes forever, so a dead consumer is
#                                         indistinguishable from a working one
#
# Liveness for this service is the supervisor's: a restart policy, plus the
# worker's own retry and escalation. A container that cannot report unhealthy
# will not be restarted by an orchestrator that only acts on health — which is
# the honest trade here rather than a probe that lies.

ARG NODE_IMAGE=node:24-slim

# ── builder ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder

ENV CI=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /w

RUN corepack enable

# Manifests BEFORE source: this is the layer that makes dependency installs
# cacheable, so editing a .ts file invalidates nothing above it. The list must be
# COMPLETE — every workspace member's package.json is an input to resolution.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json    apps/api/
COPY apps/web/package.json    apps/web/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

COPY apps/worker/ apps/worker/

# build.mjs bundles with `packages: "external"` (same reasoning as apps/api), so
# the runtime needs a resolved production tree — and it copies src/ops/templates
# into dist/, because --sync-hooks rewrites files from that tree and esbuild
# inlines JavaScript only.
RUN pnpm --filter @pr-agent/worker run build \
 && test -s apps/worker/dist/index.js \
 && ls apps/worker/dist/ops/templates >/dev/null

# ── runtime ────────────────────────────────────────────────────────────────
# No `pnpm install` here: `pnpm deploy` builds its own resolved tree, and a second
# install only leaves a redundant prod tree in an intermediate layer.
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

RUN pnpm --filter @pr-agent/worker deploy --prod --legacy /app

# dist/ is gitignored, so `pnpm deploy` skips it. Copied from the builder by hand
# for the same reason as apps/api: without it the entrypoint exits on
# MODULE_NOT_FOUND with an empty requireStack.
COPY --from=builder --chown=node:node /w/apps/worker/dist/ /app/dist/

RUN test -s /app/dist/index.js

# node (uid 1000) ships in the base image. Nothing in the payload needs root.
# --no-dereference: the tree is full of symlinks into .pnpm, and chown would
# otherwise follow them and rewrite ownership of the store too.
RUN chown -R --no-dereference node:node /app
USER node

WORKDIR /app

# No EXPOSE: there is no port. Declaring one would imply a reachable service that
# does not exist.
#
# The fixed program goes in ENTRYPOINT, not CMD, and that is load-bearing. With a
# CMD, `docker run pr-agent-worker --sync-status` REPLACES the whole command, so
# the process would be handed `--sync-status` as the program to run and die with
# "No such file or directory". With an ENTRYPOINT the arguments append, which is
# what makes the documented CLI reachable from a container at all.
ENTRYPOINT ["node", "dist/index.js"]
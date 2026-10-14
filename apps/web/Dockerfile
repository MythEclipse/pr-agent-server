# syntax=docker/dockerfile:1
#
# PR Agent web SPA — production image.
#
# Build from the REPO ROOT: apps/web depends on @pr-agent/api, so the workspace
# has to be present.
#
#   docker build -f apps/web/Dockerfile -t pr-agent-web .
#
# Vite SPA. vite.config.ts sets build.outDir = "dist" and the app reaches the API
# by relative path through the dev proxy, so there is no VITE_API_BASE_URL to bake
# and no build arg is needed here.

ARG NODE_IMAGE=node:24-slim

# ── build ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build

ENV CI=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /w

RUN corepack enable

# Manifests BEFORE source: this is the layer that makes dependency installs
# cacheable, so editing a .tsx file invalidates nothing above it. The list must be
# COMPLETE — every workspace member's package.json is an input to resolution.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json    apps/api/
COPY apps/web/package.json    apps/web/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

COPY apps/web/ apps/web/
# The SPA imports @pr-agent/api for its router definitions, which are TypeScript
# source. Vite resolves that at BUILD time, so the sources have to be present.
COPY apps/api/ apps/api/

# `vite build`, not `moon run web:build`: the moon task also runs `tsr generate`,
# whose route tree is committed, and pulling in moon here would add a toolchain the
# image does not otherwise need.
RUN pnpm --filter @pr-agent/web run build \
 && test -s apps/web/dist/index.html \
 && ls apps/web/dist/assets/ >/dev/null

# ── runtime ────────────────────────────────────────────────────────────────
# Pinned, not `nginx:alpine`: a floating tag means the config below is validated
# against a server whose directives may have changed.
FROM nginx:1.27-alpine AS runtime

# `set` is a server/location directive, NOT http-level: declaring the upstream
# variable here fails with
#   nginx: [emerg] "set" directive is not allowed here in
#     /etc/nginx/conf.d/00-upstream.conf:2
# so it lives in the server block and only the resolver is injected. The resolver
# points at Docker's embedded DNS, 127.0.0.11.
RUN echo 'resolver 127.0.0.11 valid=10s ipv6=off;' \
  > /etc/nginx/conf.d/00-upstream.conf

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /w/apps/web/dist/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:80/ || exit 1
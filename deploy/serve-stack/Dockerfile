# syntax=docker/dockerfile:1.7
#
# pangolin-orchestrator serve container — deploy/serve-stack (always-on production).
#
# Runs the tick+inbox serve() loop.  This container is the sole SQLite owner and
# the only orchestrator.tick() caller.  Workers are launched as Docker siblings
# via the host socket (mounted by docker-compose, NOT wired here).
#
# Build context MUST be the repo root so the lockfile, pnpm-workspace.yaml,
# packages/*, examples/*, and deploy/* are available to the builder stage.
#
# Multi-stage layout:
#   1. builder  — full workspace install + `pnpm -r build` so pangolin-orchestrator
#                 dist is compiled.
#   2. runtime  — node:20-slim with the built workspace copied in; the entrypoint
#                 is plain node (no tsx needed — deploy config is pure .mjs
#                 importing built dist, unlike the example which uses TS sources).
#
# No EXPOSE — the serve container opens no inbound port.

ARG NODE_VERSION=20
ARG PNPM_VERSION=9.15.4

# --- builder ------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS builder
ARG PNPM_VERSION
WORKDIR /workspace

# Corepack ships with Node 20 and is the supported way to pin pnpm.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy workspace manifests first for maximum layer-cache reuse on pnpm install.
# Source changes do not invalidate the install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY examples ./examples
COPY deploy ./deploy

# Full install — workspace deps cross-link transparently.
RUN pnpm install --frozen-lockfile

# Build the orchestrator and all its workspace dependencies so dist/ exists.
# The serve entrypoint imports from @quarry-systems/pangolin-orchestrator which
# resolves to packages/pangolin-orchestrator/dist after this step.
RUN pnpm -r run build

# --- runtime ------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

# ca-certificates for any outbound TLS (S3/MinIO).
# Also create a dedicated non-root system user (pangolin:pangolin, uid/gid 1000) to
# mirror the pangolin-worker image's proven pattern — running as root with a
# mounted Docker socket is a security gap.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && (userdel -r node 2>/dev/null || true) \
 && (groupdel node 2>/dev/null || true) \
 && groupadd --system --gid 1000 pangolin \
 && useradd --system --uid 1000 --gid 1000 --create-home --home-dir /home/pangolin pangolin

WORKDIR /workspace

# Copy the full built workspace (including node_modules with compiled package
# dist/ directories).
COPY --from=builder /workspace ./

# Give the non-root user ownership of /workspace so the SQLite volume path
# (mounted here by compose) is writable.
RUN chown -R pangolin:pangolin /workspace

# NODE_ENV=production is set here (runtime only). The builder intentionally
# omits NODE_ENV so devDeps are installed by pnpm.
ENV NODE_ENV=production

# NOTE for docker-compose: the non-root user needs access to the mounted
# /var/run/docker.sock. Handle this at runtime via `group_add` in compose
# (adding the socket's gid) — do NOT bake it into the image.
USER pangolin:pangolin

# Plain node — the deploy entrypoint imports only built .mjs/dist outputs,
# no TypeScript sources (unlike the example which requires tsx for TS-source
# config imports). No tsx dependency in this package.
CMD ["node", "deploy/serve-stack/serve-entrypoint.mjs"]

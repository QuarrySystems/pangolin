# syntax=docker/dockerfile:1.7
#
# pangolin-worker OCI image.
#
# The published image at ghcr.io/quarrysystems/pangolin-worker bundles the
# runtime-agnostic worker (`@quarry-systems/pangolin-worker`) plus the stock
# Claude Code runtime adapter (`@quarry-systems/pangolin-runtime-claude-code`).
# The adapter is placed at `/opt/pangolin/adapters/claude-code/index.js` because
# that is the discovery path the worker's adapter-loader (§5.8) probes for
# PANGOLIN_RUNTIME_ADAPTER=claude-code (the stock default).
#
# Build context MUST be the repo root so the workspace lockfile, the
# pnpm-workspace.yaml manifest, and every `packages/*/package.json` referenced
# by the lockfile are available to the builder stage.
#
# Multi-stage layout:
#   1. builder       — full workspace install + `pnpm -r build` to compile TS.
#   2. worker-deploy — `pnpm deploy --prod` of the worker into /deploy/worker.
#   3. adapter-deploy — `pnpm deploy --prod` of the adapter into /deploy/adapter.
#   4. runtime       — minimal node:20-slim runtime with bash, the deployed
#                      worker, and the deployed adapter at the canonical paths.

ARG NODE_VERSION=20
ARG PNPM_VERSION=9.15.4

# --- builder ----------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS builder
ARG PNPM_VERSION
WORKDIR /workspace

# Corepack ships with Node 20 and is the supported way to pin pnpm.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy lockfile + workspace manifest + every package.json first so pnpm install
# can populate the store with maximum layer cache reuse. Package source changes
# do not invalidate the install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages ./packages
COPY examples ./examples

# Full install (NodeNext + workspace deps cross-link transparently).
RUN pnpm install --frozen-lockfile

# Build only the packages needed inside the worker image. pangolin-worker pulls
# pangolin-core + pangolin-storage-local + pangolin-storage-s3 transitively, so a topo
# build with `...^` (dependencies-of, exclusive) covers them all.
RUN pnpm --filter '@quarry-systems/pangolin-worker...' run build \
 && pnpm --filter '@quarry-systems/pangolin-runtime-claude-code...' run build

# --- worker-deploy ---------------------------------------------------------
FROM builder AS worker-deploy
RUN pnpm deploy --filter=@quarry-systems/pangolin-worker --prod /deploy/worker

# --- adapter-deploy --------------------------------------------------------
FROM builder AS adapter-deploy
RUN pnpm deploy --filter=@quarry-systems/pangolin-runtime-claude-code --prod /deploy/adapter

# --- runtime --------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

# bash is required by the worker's setup-script runner (`/bin/bash`); ca-certs
# are needed by any outbound TLS the runtime adapter or notifications use.
# git lets capability bundles do git-push workflows (§6.5) without a custom
# image. Everything else stays opinionated to the bare minimum.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && (userdel -r node 2>/dev/null || true) \
 && (groupdel node 2>/dev/null || true) \
 && groupadd --system --gid 1000 pangolin \
 && useradd --system --uid 1000 --gid 1000 --create-home --home-dir /home/pangolin pangolin

# Install Claude Code globally so the stock claude-code adapter can spawn the
# `claude` binary. Without an ANTHROPIC_API_KEY the binary still launches
# cleanly and returns a non-zero exit with a clear missing-credential message,
# which the worker surfaces as `dispatch.failed` with a 'provider-failed'
# reason — the documented v0.1 behavior for hello-world dispatches that omit
# Anthropic credentials.
RUN npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

# Deployed worker package: places /opt/pangolin/worker/{package.json,dist,node_modules}
COPY --from=worker-deploy /deploy/worker /opt/pangolin/worker

# Deployed adapter: the dist barrel + its node_modules are placed directly at
# /opt/pangolin/adapters/claude-code so the adapter-loader's
# `<adaptersRoot>/<name>/index.js` resolution lands on the compiled barrel.
COPY --from=adapter-deploy /deploy/adapter/dist /opt/pangolin/adapters/claude-code
COPY --from=adapter-deploy /deploy/adapter/node_modules /opt/pangolin/adapters/claude-code/node_modules

# Entrypoint stub.
COPY docker/pangolin-worker/bin/pangolin-worker-entry.mjs /opt/pangolin/worker/bin/pangolin-worker-entry.mjs

# /workspace must be writable: mkdtemp under os.tmpdir() handles the workspace
# overlay but capability code that cd's into the working directory expects a
# real writable WORKDIR. Set ownership to pangolin:pangolin so the non-root user can
# create/delete files freely.
RUN mkdir -p /workspace \
 && chown -R pangolin:pangolin /workspace /opt/pangolin

WORKDIR /workspace
USER pangolin:pangolin

ENV PANGOLIN_RUNTIME_ADAPTER=claude-code \
    NODE_ENV=production

CMD ["node", "/opt/pangolin/worker/bin/pangolin-worker-entry.mjs"]

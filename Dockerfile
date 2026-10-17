# syntax=docker/dockerfile:1

# Messenger server — Next.js 16 App Router.
#
# MongoDB (replica set) and the TLS reverse proxy are EXTERNAL: this image only
# runs the Node server on port 3000 and never exposes itself publicly.
#
#   docker build -t messenger-server .
#   docker run -d --name messenger-server --env-file .env \
#     -p 127.0.0.1:3000:3000 -v messenger-blobs:/data/blobs messenger-server

FROM node:24-bookworm-slim AS base
# Pinned to the `packageManager` version in package.json. Installed via npm
# rather than corepack: corepack's bundled signing keys expire and its
# downloads are an extra failure mode in offline/CI builds.
RUN npm install -g pnpm@11.15.1
WORKDIR /app

# Dependencies are installed in their own layer so edits to app code reuse it.
# pnpm-workspace.yaml is required: it carries the `allowBuilds` entries (sharp)
# that pnpm 11 needs before it will run install scripts.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

# The runner only needs runtime dependencies. `next start` reads next.config.ts
# at runtime, but Next transpiles it with its own bundled compiler, so the
# `typescript` devDependency is not required to boot.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --prod --frozen-lockfile --store-dir /pnpm/store

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# `pnpm build` downloads the compiled Compose Multiplatform client from the
# parent repository's rolling `web-client` GitHub release into public/app/.
# Leave both empty to ship without /app (a warning, not a failure); set
# WEB_CLIENT_REQUIRED=1 where shipping it is mandatory. WEB_CLIENT_URL bypasses
# the GitHub lookup entirely (air-gapped or private mirrors).
ARG WEB_CLIENT_URL=""
ARG WEB_CLIENT_REQUIRED=""
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN WEB_CLIENT_URL="$WEB_CLIENT_URL" \
    WEB_CLIENT_REQUIRED="$WEB_CLIENT_REQUIRED" \
    pnpm build && rm -rf .next/cache

FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    BLOB_STORAGE_DIR=/data/blobs
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/package.json /app/next.config.ts ./
RUN mkdir -p /data/blobs && chown -R node:node /data
USER node
EXPOSE 3000
# /api/plans is public and touches MongoDB, so this reports real readiness
# instead of only "the HTTP listener is up".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/api/plans').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start"]

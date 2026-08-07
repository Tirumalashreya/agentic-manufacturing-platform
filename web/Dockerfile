# Config-only: not built/run in this environment (no Docker installed locally).
#
# Build from the REPO ROOT (npm workspaces need the full monorepo context):
#   docker build -f web/Dockerfile -t aps/web .
# Run:
#   docker run --env-file web/.env -p 3000:3000 aps/web
#
# Relies on next.config.ts's `output: "standalone"` so the final image only
# needs the traced server bundle, not the full node_modules tree.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY web ./web
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app ./
RUN npm run -w @aps/domain prisma:generate
RUN npm run -w @aps/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/web/.next/standalone ./
COPY --from=builder /app/web/.next/static ./web/.next/static
COPY --from=builder /app/web/public ./web/public

EXPOSE 3000
CMD ["node", "web/server.js"]

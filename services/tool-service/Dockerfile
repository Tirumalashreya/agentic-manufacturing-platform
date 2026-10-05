# Config-only: written to match §14/§15 of the architecture doc. This image
# has not been built or run in this environment (no Docker installed locally)
# — build/run correctness is unverified, unlike the rest of this codebase.
#
# Build from the REPO ROOT (npm workspaces need the full monorepo context):
#   docker build -f services/tool-service/Dockerfile -t aps/tool-service .
# Run:
#   docker run --env-file services/tool-service/.env -p 4011:4011 aps/tool-service

FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services

RUN npm ci
RUN npm run -w @aps/domain prisma:generate

WORKDIR /app/services/tool-service
ENV NODE_ENV=production
EXPOSE 4011
CMD ["npm", "run", "start"]

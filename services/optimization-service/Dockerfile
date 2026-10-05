# Config-only: written to match §14/§15 of the architecture doc. This image
# has not been built or run in this environment (no Docker installed locally)
# — build/run correctness is unverified, unlike the rest of this codebase.
#
# Build from the REPO ROOT (npm workspaces need the full monorepo context):
#   docker build -f services/optimization-service/Dockerfile -t aps/optimization-service .
# Run:
#   docker run --env-file services/optimization-service/.env -p 4006:4006 aps/optimization-service

FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services

RUN npm ci
RUN npm run -w @aps/domain prisma:generate

WORKDIR /app/services/optimization-service
ENV NODE_ENV=production
EXPOSE 4006
CMD ["npm", "run", "start"]

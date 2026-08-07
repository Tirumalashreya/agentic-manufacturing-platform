# Config-only: written to match §14/§15 of the architecture doc. This image
# has not been built or run in this environment (no Docker installed locally)
# — build/run correctness is unverified, unlike the rest of this codebase.
#
# Build from the REPO ROOT (npm workspaces need the full monorepo context):
#   docker build -f services/reporting-service/Dockerfile -t aps/reporting-service .
# Run:
#   docker run --env-file services/reporting-service/.env -p 4016:4016 aps/reporting-service

FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services

RUN npm ci
RUN npm run -w @aps/domain prisma:generate

WORKDIR /app/services/reporting-service
ENV NODE_ENV=production
EXPOSE 4016
CMD ["npm", "run", "start"]

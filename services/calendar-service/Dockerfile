# Config-only: written to match §14/§15 of the architecture doc. This image
# has not been built or run in this environment (no Docker installed locally)
# — build/run correctness is unverified, unlike the rest of this codebase.
#
# Build from the REPO ROOT (npm workspaces need the full monorepo context):
#   docker build -f services/calendar-service/Dockerfile -t aps/calendar-service .
# Run:
#   docker run --env-file services/calendar-service/.env -p 4013:4013 aps/calendar-service

FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services

RUN npm ci
RUN npm run -w @aps/domain prisma:generate

WORKDIR /app/services/calendar-service
ENV NODE_ENV=production
EXPOSE 4013
CMD ["npm", "run", "start"]

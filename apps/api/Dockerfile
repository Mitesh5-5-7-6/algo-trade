FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# 1. Prune
FROM base AS builder
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app
RUN pnpm add -g turbo
COPY . .
RUN turbo prune @neelkanth/api --docker

# 2. Install & Build
FROM base AS installer
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app

# First install dependencies (as they change less often)
COPY .gitignore .gitignore
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# Build the project and its dependencies
COPY --from=builder /app/out/full/ .
RUN pnpm turbo run build --filter=@neelkanth/api...

# 3. Runner
FROM base AS runner
WORKDIR /app

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 apiuser
USER apiuser

# Copy installed dependencies and built files
COPY --from=installer --chown=apiuser:nodejs /app .

# Set working directory to the api app
WORKDIR /app/apps/api

# Run it
CMD ["pnpm", "start"]

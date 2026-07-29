FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# 1. Prune
FROM base AS builder
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app
RUN pnpm add -g turbo
COPY . .
RUN turbo prune @neelkanth/dashboard --docker

# 2. Install & Build
FROM base AS installer
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app

COPY .gitignore .gitignore
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

ARG NEXT_PUBLIC_API_BASE=/api
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE

COPY --from=builder /app/out/full/ .
# Since the dashboard uses a static export (Next.js output: export), this builds the 'out' directory
RUN pnpm turbo run build --filter=@neelkanth/dashboard...

# 3. Runner (Nginx for static export)
FROM nginx:alpine AS runner
WORKDIR /usr/share/nginx/html
# Remove default nginx static assets
RUN rm -rf ./*
# Copy static export from the builder
COPY --from=installer /app/apps/dashboard/out .

# Provide a simple nginx conf to handle SPA routing if needed (though we use Next.js, and static export routes are mostly explicit HTML files)
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

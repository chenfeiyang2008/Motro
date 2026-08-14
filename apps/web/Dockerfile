# syntax=docker/dockerfile:1
# Motro Web（Next.js standalone）多阶段镜像。
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY tests/package.json tests/package.json
RUN pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages
COPY db db
COPY tests tests
# 同源 rewrite 目标在构建期烘焙进 next.config。
ARG API_INTERNAL_URL=http://127.0.0.1:3000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN pnpm build && pnpm --filter @motro/web build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3001
CMD ["node", "apps/web/server.js"]

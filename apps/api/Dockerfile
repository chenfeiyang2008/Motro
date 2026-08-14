# syntax=docker/dockerfile:1
# Motro API（Nest/Fastify）多阶段镜像。
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

# 先复制清单以利用依赖缓存。
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

# 复制源码并构建全部 workspace 包 + API。
COPY apps apps
COPY packages packages
COPY db db
COPY tests tests
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=development
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

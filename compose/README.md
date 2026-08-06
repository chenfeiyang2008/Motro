# Compose 开发环境

本地开发的基础 Compose 环境。当前提供三个服务：`db`（PostgreSQL）、`api`（Nest/Fastify）、`web`（Next.js）。`worker` 服务尚未实现（见下方「预留服务契约」）。

## 前提

- 安装 Docker Desktop（或等效的 Docker + Compose v2 运行时）。
- 本机不需要全局安装 Postgres——它运行在容器中。

## 启动

在仓库根目录：

```sh
cp .env.example .env          # 首次；本地开发示例值
docker compose -f compose/docker-compose.yml up --build -d
docker compose -f compose/docker-compose.yml ps
```

`db` 健康就绪后（`ps` 中 `healthy`），`api` 与 `web` 自动启动：`api` 监听 `127.0.0.1:3000`，`web` 监听 `127.0.0.1:3001`（同源 `/api/*` 代理到 API）。本机工具可从 `127.0.0.1:5432` 直连数据库，用户名/密码/库名来自 `.env`。

## 端口与数据

- `db` 只绑定回环地址 `127.0.0.1:5432`，默认不暴露公网。
- 数据保存在命名卷 `motro_db-data`，映射到容器的 `/var/lib/postgresql/data`。
- 查看日志：`docker compose -f compose/docker-compose.yml logs -f db`。

## 停止与清理

```sh
# 停止容器，保留数据卷（推荐，数据仍在）
docker compose -f compose/docker-compose.yml down

# 彻底删除容器与数据卷（不可恢复，仅确认需要清库时使用）
docker compose -f compose/docker-compose.yml down -v
```

`down` 不会删除数据；`down -v` 才会删除命名卷数据，两者风险差别请在执行前确认。

## 预留服务契约

以下服务在后续票据实现后按此契约接入同一个 `motro-net` 网络，端口均只绑定 `127.0.0.1`：

| 服务     | 端口 | 关键环境变量                                                     | 依赖        |
| -------- | ---- | ---------------------------------------------------------------- | ----------- |
| `db`     | 5432 | `POSTGRES_*`                                                     | —           |
| `api`    | 3000 | `POSTGRES_HOST=db`、`POSTGRES_*`、`API_PORT`                     | db healthy  |
| `web`    | 3001 | `API_PUBLIC_URL`、`API_INTERNAL_URL=http://api:3000`、`WEB_PORT` | api started |
| `worker` | —    | `POSTGRES_HOST=db`、`POSTGRES_*`                                 | db healthy  |

服务之间通过服务名（如 `db`、`api`）在 `motro-net` 内互访，不依赖宿主机别名。

## 从空库启动到 Web 登录（阶段出口流程）

前置：已 `cp .env.example .env`。

```sh
# 1. 启动数据库并迁移
docker compose -f compose/docker-compose.yml up -d db
pnpm db:migrate

# 2. 引导首位管理员（密码仅通过环境变量注入，不写入文件/日志）
BOOTSTRAP_ADMIN_PASSWORD='一个至少12字符的强口令' pnpm db:bootstrap-admin

# 3. 启动 API 与 Web（两个终端）
pnpm --filter @motro/api build && node apps/api/dist/main.js
pnpm --filter @motro/web dev
```

浏览器打开 `http://127.0.0.1:3001/login`，用管理员账号登录后创建学习者，再用一次性密码完成首次改密闭环。

### 认证 Web E2E（需要上述栈已启动）

```sh
E2E_ADMIN_USERNAME=admin E2E_ADMIN_PASSWORD='同一个强口令' \
  pnpm exec playwright test tests/e2e/auth.spec.ts --project=chromium --project=webkit
```

API 不可达时该 E2E 自动跳过（不会伪造登录）；设置 `MOTRO_REQUIRE_DB=1` 时不可达会直接失败（CI 使用）。

> 限制说明：登录限速为进程内滑动窗口（IP+账号双层），仅单实例有效；多实例部署需引入共享存储。

### 清理

```sh
docker compose -f compose/docker-compose.yml down      # 保留数据卷
docker compose -f compose/docker-compose.yml down -v   # 清库（不可恢复）
```

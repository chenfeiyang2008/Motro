# Motro

Motro 是面向小规模受邀用户的英语词汇学习系统。首版提供响应式 Web 学习端和管理端，部署在家庭服务器上；原生 Android、iOS 与 macOS 客户端后续独立规划。

当前仓库处于“文档与设计基线”阶段，不包含业务实现。开始工作前请依次阅读：

1. [`PRODUCT.md`](PRODUCT.md)：稳定的产品目标与边界。
2. [`CONTEXT.md`](CONTEXT.md)：统一领域语言。
3. [`DESIGN.md`](DESIGN.md)：所有 UI 工作的最高优先级约束。
4. [产品规格](.scratch/motro/spec.md)：用户故事、规则和验收标准。
5. [架构总览](docs/architecture/overview.md) 与相关 [ADR](docs/adr/README.md)。

详细文档索引见 [`docs/README.md`](docs/README.md)。

## 本地开发（平台基础阶段）

**环境要求**

- Node.js `22.x`（LTS；`.nvmrc` 固定为 `22`，推荐使用 nvm）。
- pnpm 由 [Corepack](https://nodejs.org/api/corepack.html) 管理，版本由根 `package.json` 的 `packageManager` 字段固定（当前 `pnpm@9.15.0`）。无需全局安装 pnpm。

**安装依赖**

```sh
corepack pnpm install
```

依赖下载已通过项目内 `.npmrc` 统一走 npmmirror 镜像，无需修改全局配置。若 Corepack 拉取 pnpm 本身需要走镜像，可对单条命令设置环境变量：

```sh
COREPACK_NPM_REGISTRY=https://registry.npmmirror.com corepack pnpm install
```

**统一脚本**（在仓库根目录运行）

```sh
pnpm format     # 检查格式
pnpm lint       # ESLint
pnpm typecheck  # 严格 TypeScript 检查
pnpm test       # Vitest（骨架阶段允许无测试文件）
pnpm build      # 编译全部 workspace 包
```

**下一步**

当前处于“平台基础阶段”，尚无可以启动的应用。Web 与 API 应用骨架将在后续票据中建立（见 [`docs/roadmap.md`](docs/roadmap.md)）。验证工具链正常可依次运行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`。

## 导入 E2E 运行说明（独立数据库）

`tests/e2e/admin-imports.spec.ts` 会提交导入批次，产生**不可变** commit facts（`import_batch_commits` / `import_batch_commit_rows`，`BEFORE DELETE` trigger 拒绝删除）。在共享开发库上删除这些事实必须绕过触发器/外键（被禁止），因此导入 E2E **必须运行在独立数据库**上。

**唯一推荐入口（一键 runner，自动完成启动→迁移→测试→清理）：**

```sh
E2E_ADMIN_PASSWORD=<管理员引导口令> pnpm run e2e:import
```

该命令会严格按序执行（全部只作用于独立 E2E 栈，绝不触碰共享 `motro` 栈）：

1. 启动独立栈：`docker compose -f compose/e2e-import.yml up -d --build`
2. 等待 `db-e2e` 与 `api-e2e` readiness
3. 对独立库 `motro_e2e_import` 执行 migration `0001`–`0024`
   （**强制**连接 `127.0.0.1:5433`，绝不继承 `POSTGRES_HOST`/远程库；凭据使用独立命名空间
   `E2E_POSTGRES_USER`/`E2E_POSTGRES_PASSWORD`，不依赖根 `.env` 的 `POSTGRES_*`；不需要手动 source `.env`）
4. 校验独立库已迁移到版本 24
5. 运行 `admin-imports.spec.ts`（Chromium + WebKit 并发；每个 project 使用独立管理员与独立 storageState 文件）
6. **无论测试通过、失败或中断**，最后执行 `docker compose -f compose/e2e-import.yml down -v` 清理独立栈

**清理与中断边界：**

- 正常失败、readiness/migration/Playwright 失败、以及可处理的 `SIGINT`/`SIGTERM` 都会自动执行一次 `down -v`。
- `SIGKILL`、断电或宿主崩溃无法被进程捕获：此时请手动执行
  `docker compose -f compose/e2e-import.yml down -v` 清理独立栈（只影响独立卷，不影响共享 `motro` 栈）。

**独立栈凭据命名空间（Compose 与宿主工具共用同一契约）：**

| 变量                    | 默认值               | 说明                                                       |
| ----------------------- | -------------------- | ---------------------------------------------------------- |
| `E2E_IMPORT_DB`         | `motro_e2e_import`   | 独立库名（白名单 `^motro_e2e_import(_[a-z0-9-]{1,40})?$`） |
| `E2E_POSTGRES_PORT`     | `5433`               | 独立库宿主端口                                             |
| `E2E_POSTGRES_USER`     | `motro_e2e`          | 独立库用户（不读取 `POSTGRES_USER`）                       |
| `E2E_POSTGRES_PASSWORD` | `e2e_only_change_me` | 独立库口令（不读取 `POSTGRES_PASSWORD`）                   |
| `E2E_SESSION_KEY`       | 隔离栈专用           | 独立栈 session key（不继承 `SESSION_KEY`）                 |
| `E2E_CSRF_KEY`          | 隔离栈专用           | 独立栈 CSRF key（不继承 `CSRF_KEY`）                       |

宿主侧 migration / 管理员创建 / 清理一律通过 `resolveIsolatedE2eTarget()` 解析为固定的 `127.0.0.1` 连接，
不继承任何 `POSTGRES_HOST` / `API_PUBLIC_URL` / `PW_BASE_URL` 的远程值；API/Web 固定 `127.0.0.1:3100/3101`。

**手动逐步执行（等价于 runner，便于排查）：**

```sh
# 1. 启动隔离栈
docker compose -f compose/e2e-import.yml up -d --build

# 2. 等待就绪
sleep 10 && curl -s http://127.0.0.1:3100/api/v1/health/live

# 3. 迁移独立库（明确指向本机独立库 127.0.0.1:5433；使用 E2E_POSTGRES_* 命名空间；不碰共享库）
E2E_IMPORT_DB=motro_e2e_import E2E_POSTGRES_PORT=5433 \
E2E_POSTGRES_USER=motro_e2e E2E_POSTGRES_PASSWORD=e2e_only_change_me \
POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5433 POSTGRES_DB=motro_e2e_import \
POSTGRES_USER=motro_e2e POSTGRES_PASSWORD=e2e_only_change_me pnpm db:migrate

# 4. 运行导入 E2E（Chromium + WebKit 并发）
E2E_IMPORT_DB=motro_e2e_import \
E2E_POSTGRES_PORT=5433 \
E2E_ADMIN_PASSWORD=<管理员引导口令> \
API_PUBLIC_URL=http://127.0.0.1:3100 \
PW_BASE_URL=http://127.0.0.1:3101 \
PW_WEB_PORT=3101 \
PW_REUSE_SERVER=1 \
pnpm exec playwright test tests/e2e/admin-imports.spec.ts --project=chromium --project=webkit

# 5. 清理（只移除 motro-e2e-import 资源与卷，不影响共享 motro 栈）
docker compose -f compose/e2e-import.yml down -v
```

**故障排查：**

```sh
docker compose -f compose/e2e-import.yml logs api-e2e web-e2e db-e2e
```

**说明：**

- 独立栈名称 `motro-e2e-import`，独立 API/Web 端口 `3100/3101`，独立数据库端口 `5433`，独立命名卷 `e2e-import-db-data`，与 `compose/docker-compose.yml` 的 `motro` 栈完全隔离。
- `admin-imports.spec.ts` 在 `beforeAll` 检测到未设置 `E2E_IMPORT_DB` 时**直接失败**，绝不回退共享库。
- 隔离管理员在独立库中创建/清理；Chromium 与 WebKit 各自使用独立管理员用户名与独立 storageState 文件（`tests/e2e/.auth/imports-<run-id>-<project>.json`），并发执行时互不抢占。
- 不可变 commit facts 由 `down -v` 整体销毁独立数据库卷处理，**绝不通过绕过 trigger 删除**。

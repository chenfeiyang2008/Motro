# Motro

Motro 是一个面向小规模受邀用户的英语词汇学习系统（约 20 人），采用 TypeScript 严格模式的 pnpm monorepo 实现：Next.js 提供响应式 Web 学习端与管理端（`/admin` 路由组），NestJS + Fastify 提供 `/api/v1` 接口（生成 OpenAPI），Graphile Worker 处理后台任务，PostgreSQL 作为唯一事实来源（经 Drizzle 与有序 SQL 迁移）。内容管线支持 TXT/CSV/XLSX/JSON 四种格式导入，经校验、Wiktionary 适配器、DeepSeek 中文草稿、人工复核后生成词条；学习端提供日计划、选课、双向卡片复习（FSRS v6）、个人资料；管理端覆盖用户、词条、导入、复核、课程发布、会员与激励/XP 运营。当前为可运行的完整实现，部署在家庭服务器或局域网内网，Web-only（暂无原生客户端）。

## 文档索引

完整手册见 [`docs/MOTRO-GUIDE.md`](docs/MOTRO-GUIDE.md)，文档总索引见 [`docs/README.md`](docs/README.md)。开始工作前建议依次阅读：

1. [`PRODUCT.md`](PRODUCT.md)：稳定的产品目标与边界。
2. [`CONTEXT.md`](CONTEXT.md)：统一领域语言。
3. [`DESIGN.md`](DESIGN.md)：所有 UI 工作的最高优先级约束。
4. [产品规格](.scratch/motro/spec.md)：用户故事、规则和验收标准。
5. [架构总览](docs/architecture/overview.md) 与相关 [ADR](docs/adr/README.md)。

## 技术栈

- **语言/运行时**：TypeScript（strict）、Node.js 22 LTS（`.nvmrc` 固定为 `22`）。
- **包管理**：pnpm 9（由 Corepack 管理，`packageManager` 字段固定为 `pnpm@9.15.0`）。
- **Web**：Next.js（学习端 + `/admin` 路由组），Tailwind + 自定义设计令牌。
- **API**：NestJS + Fastify，托管于 `/api/v1`，自动生成 OpenAPI（见 `docs/generated/openapi.json`）。
- **数据库**：PostgreSQL（事实来源），Drizzle ORM + 显式有序 SQL 迁移（当前最高 `0046`）。
- **后台任务**：Graphile Worker（无 Redis）。
- **部署**：Docker Compose + Tailscale/Caddy，目标 4GB RAM；家庭服务器与局域网内网两种形态。

## Monorepo 布局

```
apps/{web,api,worker}      # 三个可运行应用：学习/管理端、API、后台任务
packages/{config,api-client,db,domain}  # 共享包：配置、API 客户端、数据库、领域
docs/                      # 文档（MOTRO-GUIDE、ADR、部署、测试、UI 等）
db/migrations/             # 有序 SQL 迁移（0001–0046）
tests/                     # 分层测试（domain / pg 集成 / 导入 / API·安全 / e2e / a11y / 性能）
compose/                   # Docker Compose：docker-compose.yml、intranet.yml、e2e-import.yml
prototype/  .scratch/      # 原型与临时工作区
```

## 本地开发

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
pnpm format           # 检查格式（prettier --check .）
pnpm format:check     # 同上
pnpm lint             # ESLint
pnpm typecheck        # 严格 TypeScript 检查（tsc --build）
pnpm test             # Vitest 运行分层测试套件（--passWithNoTests）
pnpm build            # 编译全部 workspace 包
```

项目已具备分层测试（领域、PostgreSQL 集成、导入、API/安全、Playwright e2e、a11y、性能/容量），并非骨架阶段。

**启动开发栈（本地）**

```sh
# 1. 启动 db/api/worker/web 四服务
docker compose -f compose/docker-compose.yml up -d --build

# 2. 迁移数据库
pnpm db:migrate

# 3. 引导首个管理员账户
pnpm db:bootstrap-admin

# 4. 启动后台任务（独立终端）
pnpm worker:start
```

验证工具链正常可依次运行 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`。

## 部署

- **家庭服务器**：Tailscale 提供 HTTPS（见 ADR-0006），详见 [`docs/deployment/home-server.md`](docs/deployment/home-server.md)。
- **局域网内网**：使用 [`compose/intranet.yml`](compose/intranet.yml)（db / worker-migrate / api / worker / web，无代理服务，由运维自行追加 Caddy）。入门指南见 [`docs/deployment/intranet-runbook.md`](docs/deployment/intranet-runbook.md) 与 [`docs/deployment/intranet-beginner-deployment-guide.md`](docs/deployment/intranet-beginner-deployment-guide.md)。
- 密钥均在部署时注入，绝不提交；安全相关配置集中在 `compose/intranet.yml`，使用 `${VAR:?}` 缺失即失败（fail-fast）。详见 [`SECURITY.md`](SECURITY.md)。

## 开源状态

Motro 以 **MIT 许可** 开源，见 [`LICENSE`](LICENSE)。欢迎通过 [`CONTRIBUTING.md`](CONTRIBUTING.md) 了解贡献方式，并遵循 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。

## 导入 E2E 运行说明（独立数据库）

`tests/e2e/admin-imports.spec.ts` 会提交导入批次，产生**不可变** commit facts（`import_batch_commits` / `import_batch_commit_rows`，`BEFORE DELETE` trigger 拒绝删除）。在共享开发库上删除这些事实必须绕过触发器/外键（被禁止），因此导入 E2E **必须运行在独立数据库**上。

**唯一推荐入口（一键 runner，自动完成启动→迁移→测试→清理）：**

```sh
E2E_ADMIN_PASSWORD=<管理员引导口令> pnpm run e2e:import
```

该命令会严格按序执行（全部只作用于独立 E2E 栈，绝不触碰共享 `motro` 栈）：

1. 启动独立栈：`docker compose -f compose/e2e-import.yml up -d --build`
2. 等待 `db-e2e` 与 `api-e2e` readiness
3. 对独立库 `motro_e2e_import` 执行 migration `0001`–`0046`
   （**强制**连接 `127.0.0.1:5433`，绝不继承 `POSTGRES_HOST`/远程库；凭据使用独立命名空间
   `E2E_POSTGRES_USER`/`E2E_POSTGRES_PASSWORD`，不依赖根 `.env` 的 `POSTGRES_*`；不需要手动 source `.env`）
4. 校验独立库已迁移到最新版本
5. 运行 `admin-imports.spec.ts` 与 `admin-operations.spec.ts`（Chromium + WebKit 并发；每个 project 使用独立管理员与独立 storageState 文件）
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

**Worker 崩溃恢复 E2E：**

- `pnpm run e2e:crash-recovery`：种入「崩溃后的残余状态」（running + 过期 lease + 旧 running attempt，
  无任何 job），启动真实 Docker worker，验证周期性 recovery loop 自动发现、重新 enqueue、重新 claim、
  最终 succeeded。断言 attempt 时间线：`attempt 1 = abandoned`、`attempt 2 = succeeded`，lease/claim 已清除。
- `pnpm run e2e:restart`：同上，但显式验证「重启 worker」路径下的自动恢复（先验证 API 持久状态，
  再重启 worker，再由 recovery loop 恢复）。

**信号边界说明（诚实声明）：**

- `SIGINT` / `SIGTERM`（可捕获）：worker 会走优雅关闭（`runner.stop()` + `pool.end()`），对在途 operation
  完成失败/中止语义，不伪造 succeeded。E2E 的 `down -v` 可被这些信号触发。
- `SIGKILL` / 断电 / 宿主崩溃（不可捕获）：worker 进程被硬杀，在途 operation 保持 `running` + lease，
  lease 到期后由 recovery loop 在下一周期发现并重新投递。E2E 中的 crash 验证采用直接种入崩溃残渣
  （确定性的权威状态），避免依赖 Graphile 对 `SIGKILL` 后残留 locked job 的重领时序。
- 恢复证据必须是「recovery loop 主动扫描并重新 enqueue」而非「收到新 job 后恢复」；两者在真实栈中
  通过 attempt 时间线（旧 abandoned + 新 succeeded）与 lease/claim 清除来区分。

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

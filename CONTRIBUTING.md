# 贡献指南（Contributing）

感谢你考虑为 Motro 做贡献。本仓库是一个面向小规模受邀用户的个人项目，欢迎 issue、讨论与 PR。

## 开发环境

- **Node.js** `>=22`（推荐与 `.nvmrc` 一致的 `22` LTS，可用 nvm 切换）。
- **pnpm** `>=9`（由 Corepack 管理，根 `package.json` 的 `packageManager` 固定为 `pnpm@9.15.0`，无需全局安装）。
- **PostgreSQL**：本地开发经 `compose/docker-compose.yml` 起的 `db` 服务；E2E 导入测试使用独立的 `compose/e2e-import.yml` 栈。

初始化：

```sh
corepack pnpm install
docker compose -f compose/docker-compose.yml up -d --build
pnpm db:migrate
pnpm db:bootstrap-admin
```

常用脚本（仓库根目录运行）：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm format:check`、`pnpm openapi:check`、`pnpm db:migrate:check`。

## 分支与提交约定

- 分支命名无强制，但请保持简短、语义化（如 `feat/admin-membership`、`fix/migrate-0046`）。
- 采用 **Conventional Commits**（`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:` 等）。
- **一次提交聚焦一件事**：避免把类型修复、新功能与格式化混在同一提交；便于 review 与回滚。
- 修改 API 契约时，请同步更新 OpenAPI（运行 `pnpm openapi:generate` 并提交 `docs/generated/openapi.json`），并保证 `pnpm openapi:check` 通过。
- 修改数据库时，新增**有序**迁移文件于 `db/migrations/`，并保证 `pnpm db:migrate:check` 通过。

## 合并前的发布闸门（Release Gates）

向 `main` 合并前，以下检查必须全绿（CI 在 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 中执行）：

```sh
pnpm typecheck      # 严格 TypeScript 构建
pnpm build          # 全部 workspace 编译
pnpm test           # Vitest 分层测试套件
pnpm format:check   # Prettier 格式
pnpm lint           # ESLint
pnpm openapi:check  # OpenAPI 契约一致性
pnpm db:migrate:check   # 迁移可应用（在受控数据库上）
```

`db:migrate:check` 需连接一个受控数据库；请勿在共享生产库上运行未经核对的迁移。E2E 导入/崩溃恢复测试（`pnpm e2e:import`、`pnpm e2e:crash-recovery`）会自行拉起独立数据库栈，不触碰共享库。

## 行为准则

参与本仓库即视为同意 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。

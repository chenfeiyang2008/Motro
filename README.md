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

# 更新日志（Changelog）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/) 精神，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 未发布（首个发行版候选）

首个发行版候选，覆盖完整的学习端与配套管理端、内容管线、会员与激励体系，以及内网部署方案。

### 新增

- **学习端**：首页/日计划、选课与主修课程、复习会话（双向卡片 + FSRS v6）、个人资料。
- **管理端**（`/admin`）：用户、词条、导入、复核、课程草稿与发布、会员运营、激励/XP 管理。
- **内容管线**：TXT/CSV/XLSX/JSON 四格式导入 → 校验 → Wiktionary 适配器 → DeepSeek 中文草稿 → 人工复核 → 词条（部分阶段进行中）。
- **适配器**：Wiktionary 与 DeepSeek 均支持 fake（仅本地模拟）/ real 两种 provider 模式，默认 fake 不发起真实网络请求。
- **激励与成长**：版本化的游戏规则、每个合格事件固定 5 XP、连击与保护、每周目标挑战（10 题测验，北京时区周窗口，独立于 XP）、每周排行榜与周奖励。
- **会员体系**：`free` / `member` 两种方案，服务端推导状态（fail-closed），免费用户每日学习时长上限，管理端会员增删改查。
- **课程发布**：不可变课程发布（ADR-0003），发布前须人工复核。
- **内网部署**：`compose/intranet.yml` 与 [`docs/deployment/intranet-runbook.md`](docs/deployment/intranet-runbook.md)、[`docs/deployment/intranet-beginner-deployment-guide.md`](docs/deployment/intranet-beginner-deployment-guide.md)。
- **数据库迁移基线**：`0046`（`db/migrations/0046_challenge_daily_usage.sql`）。
- **开源许可**：MIT（见 [`LICENSE`](LICENSE)）。

### 技术栈

TypeScript 严格模式 pnpm monorepo；Next.js 学习/管理端，NestJS + Fastify API（`/api/v1`，生成 OpenAPI），PostgreSQL（Drizzle + 有序迁移），Graphile Worker 后台任务，Docker Compose 部署，目标 4GB RAM。

> 详细历史提交记录见 `git log`。

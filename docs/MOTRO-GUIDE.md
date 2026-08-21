# Motro 全面介绍与使用说明

> 一份面向开发者、管理员与运维人员的综合手册。它把分散在 `PRODUCT.md`、`CONTEXT.md`、`DESIGN.md`、`docs/` 与代码中的事实汇集成统一的、可读的说明。
>
> 阅读约定：本文以**当前代码仓库的实际状态**为准（截至 2026-08），并在多处标注「文档基线」与「已实现扩展」的差异。权威约束仍依次是：`PRODUCT.md` / `CONTEXT.md` → `DESIGN.md` → `docs/` → 已提交代码 → 本文。

---

## 目录

1. [Motro 是什么](#1-motro-是什么)
2. [产品定位与目标用户](#2-产品定位与目标用户)
3. [核心概念与术语表](#3-核心概念与术语表)
4. [系统架构总览](#4-系统架构总览)
5. [技术栈与 Monorepo 结构](#5-技术栈与-monorepo-结构)
6. [学习者使用流程](#6-学习者使用流程)
7. [管理员使用流程](#7-管理员使用流程)
8. [功能模块详解](#8-功能模块详解)
9. [设计语言速览](#9-设计语言速览)
10. [本地开发与运行](#10-本地开发与运行)
11. [部署指南](#11-部署指南)
12. [测试与质量门禁](#12-测试与质量门禁)
13. [REST API 速览](#13-rest-api-速览)
14. [路线图与当前状态](#14-路线图与当前状态)
15. [常见问题](#15-常见问题)
16. [参考文档索引](#16-参考文档索引)

---

## 1. Motro 是什么

**Motro 是面向小规模受邀用户的英语词汇学习系统**。首版提供一套响应式 Web 应用，包含**学习者端**与**管理端**，部署在家庭/内网服务器上；原生 Android、iOS、macOS 客户端在 Web 稳定后再单独立项。

它解决两件事：

- **帮助学习者每天用有限时间完成应复习内容并稳步学新词**——通过 FSRS v6 间隔重复算法独立调度每个词的「英→中」「中→英」两个记忆方向，并用服务器拥有的「每日计划」保证刷新不重复计分、不丢进度。
- **让管理员把合法来源的词表整理成可审核、可发布、可追溯的课程**——从 CSV/XLSX/JSON/TXT 导入，经 Wiktionary 补全、DeepSeek 中文草稿、人工审核，最终形成**不可变发布版本**的内容供应链。任何自动生成内容都不能绕过人工审核直接发布。

系统的气质是「现代学习工作室」：友好、活泼、克制，带轻微游戏感但不幼稚。品质来自排版、留白、层级、颜色与短促反馈，而非视觉噱头。

---

## 2. 产品定位与目标用户

### 主要用户

| 角色 | 说明 |
| --- | --- |
| **学习者** | 受邀请加入，使用简体中文**浅色** Web 界面学习英语词汇。首版规模上限约 **20 名受邀用户**，不开放注册，不提供用户生成内容。 |
| **管理员** | 创建账号，维护词条与课程，审核自动补全结果，发布内容，管理作业与会员。 |

### v1 成功标准（验收口径）

- 学习者能在现代桌面与移动浏览器稳定完成每日计划，刷新后不重复计分、不丢失已提交复习。
- 管理员能从 CSV/XLSX/JSON/逐行 TXT 导入英文拼写并发布一门课程。
- 每个方向按 FSRS v6 独立调度；两方向预计间隔均达到 **21 天**时词项标记为「已稳定」。
- 周挑战榜只由服务器判分的积分测验产生挑战积分；普通学习 XP、速度、课程难度均不参与排名。
- 20 用户、10 万课程词项、100 万复习事件规模下，核心流程满足容量标准（学习读 p95 < 500ms，复习写 p95 < 700ms）。
- 家庭/内网服务器可从空环境安装、升级、备份并恢复。

### 明确不属于 v1

原生客户端、PWA 离线、完整离线同步、深色主题、吉祥物、AI 插画、听力、拼写判题（除挑战测验内）、语法、阅读、写作、通知、邮件、公开注册、好友关系、虚拟货币、应用商店分发。

> **文档基线 vs 已实现扩展**：原始 `PRODUCT.md` 写明「当前路线不设计会员等级或付费身份徽章」。但**当前代码已包含会员体系**（免费方案 / 会员，含每日学习时长上限与会员 CRUD 管理页）。本文以实际代码为准描述会员功能，并在第 8.5 节标注。

---

## 3. 核心概念与术语表

下面是从 [`CONTEXT.md`](../../CONTEXT.md) 提炼的关键术语，按主题分组。理解这些词是读懂整个系统的基础。

### 内容（Content）

- **词条（Lexical Entry）**：全局可复用的英语词汇事实记录，至少含规范化拼写，可承载词性、发音、例句、来源。不包含某门课程专属释义，也不保存用户学习状态。
- **课程词项（Course Item）**：词条在某门课程中的稳定身份，含课程专属中文释义、教学顺序与展示内容。同一词条出现在不同课程时是不同课程词项。
- **课程（Course）**：面向特定学习目标的内容集合，由有序**单元**组成。学习者可加入多门，但同一时刻只有一门**主课程**。
- **单元（Unit）**：课程内有序的进度边界。当前单元所有课程词项完成双向首测后，下一单元解锁。
- **课程草稿（Course Draft）**：管理员可修改的课程编排工作区，尚未影响学习者。
- **发布版本（Course Release）**：草稿发布后形成的**不可变**内容快照。已发布内容不能原地修改；修订必须产生新发布版本。
- **主课程（Primary Course）**：学习者当前每日计划优先取新词与展示进度的课程。切换主课程不删除其他课程的学习历史。

### 学习（Learning）

- **学习卡（Learning Card）**：某学习者、某课程词项、某方向的可调度记忆对象。**英→中**与**中→英**是两张独立学习卡。
- **方向（Card Direction）**：只允许「英文→中文」「中文→英文」。
- **首测（Initial Review）**：学习者看过学习面后，对一个方向首次提交的有效评分。课程词项只有完成两个方向首测，才计入单元解锁条件。
- **复习事件（Review Event）**：对一张卡提交的一次**不可变**评分事实。带幂等键；重复提交不能重复调度或计 XP。
- **记忆状态（Memory State）**：由 FSRS v6 字段组成的当前调度状态（稳定性、难度、上次复习、到期时间、预计间隔）。
- **到期复习（Due Review）**：到期时间不晚于计划计算时刻、且尚无更新事件处理的学习卡。
- **已稳定（Stable Item）**：同一课程词项两卡预计间隔均 ≥ 21 天。是**派生状态**，不是人工标签。
- **每日计划（Daily Plan）**：根据时间预算生成的会话候选序列，先安排到期复习，再用新词填充剩余预算。
- **学习会话（Study Session）**：一次连续学习活动的范围，含计划快照、已展示卡片、有效复习事件。
- **学习展示（Learning Exposure）**：服务端记录学习者已看过某词项学习面的事实，使其可进入积分测验候选池（不等于首测或掌握）。

### 激励（Motivation）

- **经验值（XP）**：由有效新卡首测或到期复习事件产生的游戏积分，每个合格事件固定 **5 XP**；评分高低不影响 XP。
- **连续天数（Streak）**：按学习者时区计算的连续存在至少一个合格复习事件的本地日期数。
- **自动保护（Streak Protection）**：每连续七天获得一次、系统在符合条件漏学日自动消耗的连续天数保护。
- **挑战周（Challenge Week）**：固定使用 `Asia/Shanghai` 的周一 00:00 至下周一 00:00 的计分周期；周日 23:55 起不再创建新积分测验。
- **积分测验（Challenge Quiz）**：可无限次参加的 10 题、5 分钟专注测验。每场 10 个不同全局词条，含 5 道英→中选择、5 道中→英拼写。
- **测验题快照（Quiz Question Snapshot）**：开场冻结的题目事实（词项、释义、方向、题型、服务端答案）；之后课程修改不改变判题。
- **挑战积分（Challenge Points）**：某用户对某全局词条某方向**本周首次答对**产生的 **5 分**事实。跨课程同词同方向一周内只得一次；日常 XP 不参与。
- **积分调整（Challenge Score Adjustment）**：管理员为作废异常积分或作补偿而追加的审计事实，须含管理员、理由、时间；不得直接改写答题或总分。
- **周挑战榜（Weekly Challenge Board）**：按挑战积分排名的只读公开榜。同分时先达到该积分者在前，再按用户 ID 稳定排序。
- **周挑战奖励（Weekly Challenge Reward）**：结算时按 `floor(挑战积分 ÷ 10)` 产生的成长 XP，最多 200 XP；不反向影响周挑战榜。
- **游戏规则集（Game Rule Set）**：服务器端版本化的 XP、等级、任务、连续天数、徽章、挑战奖励与计分规则。

### 内容运营与会员

- **导入批次（Import Batch）**：一次上传的原始文件、内容哈希、列映射、校验结果、来源信息的可追溯集合。
- **补全草稿（Enrichment Draft）**：由 Wiktionary 数据与 DeepSeek 中文生成、待管理员审核的候选内容。
- **审核决定（Review Decision）**：管理员对补全草稿作出的接受 / 修改后接受 / 驳回事实，含操作者、时间、理由。
- **会员（Membership）**：当前实现的账号层级——`free`（免费方案）/ `member`（会员）。会员不限每日学习时长；免费方案有每日时长上限（见第 8.5 节）。状态由服务端计算，不可前端伪造。

---

## 4. 系统架构总览

Motro v1 是一个 **TypeScript 模块化单体（modular monolith）**，位于 **pnpm monorepo** 中。浏览器通过**版本化 REST API** 访问，绝不直接读 PostgreSQL。单一仓库 + 单一主数据库，让 20 人家庭/内网部署简单；同时明确的模块边界与平台无关的 API 契约，为日后原生客户端留出空间。

```
Browser（学习者 + 管理员）
        │ HTTPS /api/v1
        ▼
Next.js Web ──────────────► NestJS + Fastify API
                                  │
                     ┌────────────┼─────────────┐
                     ▼            ▼             ▼
                PostgreSQL   Graphile Worker  Object files
                                  │          （导入文件 / 备份）
                           Wiktionary / DeepSeek
```

- **Tailscale** 提供私有网络可达性与 HTTPS；应用自身仍负责认证、授权、CSRF、校验、限速与审计日志。Tailscale **不是**授权替代。
- 关键一致性边界全部用**单数据库事务**保证：
  - **复习提交**：锁卡 → 认领幂等键 → 校验 → 追加 `ReviewEvent` → 计算/持久化新记忆状态 → 追加合格 XP → 推进会话游标 → 提交。
  - **课程发布**：锁草稿 → 校验完整 → 分配发布号 → 复制不可变单元/词项快照（稳定 course-item ID）→ 写发布记录 → 更新当前发布指针 → enqueue 发布后作业 → 提交。
  - **挑战作答**：校验北京周与 5 分钟到期 → 锁题快照 → 认领幂等键 → 追加不可变 `QuizResponse` → 对照快照判分 → 首次答对时插入唯一 `ChallengeScoreEvent` → 重建/更新用户-周读模型（含调整）→ 提交。
- **安全基线**：Argon2id 口令哈希（参数随哈希存储并定期复核）；随机不透明服务端会话以 Secure/HttpOnly/SameSite Cookie 下发，登录/改密/提权后轮换；变更操作需 CSRF 或同源校验；API 角色守卫（不只隐藏 UI）；管理变更留审计；登录与高成本端点按账号/IP 限速；上传与供应商数据一律按不可信校验；渲染内容转义 + 受限 CSP。

详见 [`docs/architecture/overview.md`](architecture/overview.md) 与 [`docs/architecture/data-model.md`](architecture/data-model.md)。

---

## 5. 技术栈与 Monorepo 结构

### 技术栈

| 层 | 选型 |
| --- | --- |
| 语言 | TypeScript（严格模式），Node.js 22 LTS |
| 包管理 | pnpm 9（由 Corepack 管理），monorepo |
| Web | Next.js（学习者 + `/admin` 路由组），Tailwind + 项目自有组件；学习者用自托管 Lexend + 项目 token，管理用 Ant Design 映射到 Motro token |
| API | NestJS + Fastify，`/api/v1` 全局前缀；OpenAPI 从 DTO 生成 |
| 数据库 | PostgreSQL（事实来源），Drizzle 类型化访问，显式有序 SQL 迁移 |
| 后台作业 | Graphile Worker（at-least-once + 指数重试）；每 handler 带应用幂等键（v1 不引入 Redis） |
| 部署 | Docker Compose + Tailscale（家庭服务器）/ Caddy 反向代理（内网）；4 GB 内存目标 |

> ⚠️ `apps/web/AGENTS.md` 提示：当前 Next.js 版本有破坏性变更，写代码前须先读 `node_modules/next/dist/docs/` 对应指南，并留意 deprecation 通知。

### 运行时组件

- **Web**（`apps/web`）：响应式应用，学习者与管理端路由分离。服务端渲染仅通过内部服务 URL 读 API；所有业务变更与授权仍走 REST 控制器。v1 无 Service Worker / 离线缓存 / 直连数据库；刷新会从服务端恢复学习会话。
- **API**（`apps/api`）：NestJS/Fastify，模块含 `auth` `catalog` `study` `game` `admin` `operations` `membership` `motivation` `reviews`。控制器把 HTTP 翻译成应用命令/查询；领域策略不依赖 Nest、Drizzle 或 Web 类型。OpenAPI 在 CI 中作为可审查产物生成与 diff。
- **Worker**（`apps/worker`）：独立 Node 进程，对同库跑 Graphile Worker 任务（解析/导入、Wiktionary 补全、DeepSeek 草稿、发布物化、榜/统计维护、保留清理）。含 `recovery-scan` 崩溃恢复循环、真实/假供应商适配器（real/fake）、fixture handler 接口缝。
- **Database**：PostgreSQL 是内容、身份、学习、奖励、审计、后台作业的唯一事实来源。约束强制唯一性、不可变性与幂等性。UTC `timestamptz` 存时间戳；用户本地日期用 IANA 时区派生，仅当为业务事实（如 streak 日）才持久化。
- **File storage**：原始导入文件与必要派生报告存于配置目录并挂载进容器；元数据与 SHA-256 存 PostgreSQL；路径为不透明 ID，校验大小/MIME/内容、服务端生成文件名、防路径穿越；可复现/审计发布内容所需文件纳入加密备份。

### Monorepo 布局（实际）

```
apps/
  web/         Next.js 学习者 + 管理端
  api/         NestJS/Fastify HTTP 应用
  worker/      Graphile Worker 进程与任务注册
packages/
  config/      类型化运行时配置加载器
  api-client/  生成式 API 客户端/类型（不含服务内部）
  db/          Drizzle schema、repositories、显式 SQL 迁移
  domain/      纯领域策略与值对象（FSRS 适配器、游戏规则等）
docs/          所有文档（见第 16 节索引）
db/migrations/ 有序 SQL 迁移（当前至 0046）
tests/         e2e / integration / unit / fixtures
compose/       Docker Compose 与代理配置（dev / e2e / intranet）
prototype/     设计原型（brand-color / challenge / learner）
.scratch/      本地工单与规格（issue tracker 工作区）
```

---

## 6. 学习者使用流程

学习者所有界面遵循「每页只有一个主要任务，最多一个视觉最强主操作」原则。学习会话与积分测验都隐藏全局导航，只保留当前卡片/题、必要操作与逐题反馈。

### 6.1 首页（Home）

- 首屏只回答「今天该做什么」：今日课程、当前单元、到期复习、首复习、新学习、预计时间，以及唯一主操作「**开始学习**」。
- 主操作之下是「**学习观测面**」：可行动、可解释的事实——已接触词汇、双向首测完成词项、按 21 天规则计算的已稳定词汇、当前课程进度、七日学习节奏、待复习负荷。
- **诚实性约束**：「已稳定」必须标注为「两张方向卡预计间隔均 ≥ 21 天」的系统判定，≠ 永久掌握。跨课程按全局词条去重，课程内按稳定课程词项计算，两者不得混称。**绝不**根据词汇量/XP/连续天数/FSRS 间隔/课程完成度宣称 A1–C2、雅思、高考或综合英语能力。

### 6.2 选课（Courses）

- 浏览可见的已发布课程及报名摘要；课程响应暴露 `releaseId`/`releaseNumber` 以保证内容一致，不暴露可变草稿。
- 报名某课程（`POST /catalog/courses/{id}/enroll`，幂等：已报名返回现有行，不降级既有主课程）；可选 `makePrimary` 原子设为主课程。
- 切换主课程（`PUT /catalog/primary-course`）：在一事务内先清旧主课程再设新主，序列化保证每用户至多一个活跃主课程，且**永不删除**其他课程学习历史。

### 6.3 学习会话（Study）

- `POST /study/sessions` 恢复活跃会话或创建服务端计划会话。计划先排到期复习，再用新词填剩余预算。
- 每张卡以**两张独立闪卡**学习（英→中、中→英），各自维护记忆状态。学习者看过学习面后可「翻卡」（可选审计动作，不产生复习事件/XP），再提交**四级评分**（Again/Hard/Good/Easy）。
- 提交复习（`POST /study/sessions/{id}/reviews`）带 `clientEventId` 幂等键。重复相同键/体返回相同结果；同键不同语义返回 `409`。
- 会话可显式放弃（`/abandon`），或刷新后从服务端恢复（v1 无离线队列）。结束后看会话结果（`/result`）。

### 6.4 周挑战榜与积分测验（Challenge）

- 周挑战榜（`/game/leaderboard/weekly`）只显示挑战积分排名，含 `weekStartsAt/EndsAt`、周日 23:55 起始关门 `startClosedAt`、同分先达到当前分再按用户 ID 的稳定排序、退出公开榜者的个人行（仍保留积分与奖励资格）。**日常 XP 永不进入排名**。
- 积分测验（`/game/challenge/attempts`）本周对每个全局词条方向**首次答对**才得 5 分；10 题、5 分钟、10 个不同全局词条（5 道英→中选择 + 5 道中→英拼写）。创建需幂等键、≥10 个已展示的不同词条、且在北京时间周日 23:55 前。
- 中→英拼写比对仅做 Unicode 归一化 + 小写 + 去首尾空白；内部必需空格/连字符保持精确；接受集为快照规范拼写 + 管理员批准别名；无模糊或 AI 判题。
- 超时结束测验；之后提交返回最终态。作答即获即时判分、正确答案与小幅排名摘要。

### 6.5 个人页（Profile）

- 查看进度与偏好，包括公开榜参与开关。可改显示名、时区、每日预算、公开挑战榜参与（`PATCH /profile`）。
- 时区变更会校验/限速，影响未来个人计算；挑战周时间始终是北京时间，不随资料时区变化。

### 6.6 会员状态（当前实现）

- 首页/资料/排行榜依据服务端计算的会员状态显示：会员显示「今日学习不限时」；免费显示「今日剩余 N 分钟 · 明日重置」。非会员有每日学习时长上限，超过后计入次日重置。

---

## 7. 管理员使用流程

管理端在信息架构上与学习区明确分离（独立后台侧栏），**不建设「全能控制台」**——按账号、词条、导入、审核、课程编排、发布、会员、作业状态分开。所有管理变更留审计记录。

| 步骤 | 界面 / API | 做什么 |
| --- | --- | --- |
| 创建账号 | `admin/users` | 创建受邀学习者/管理员；可禁用并撤销会话、发放一次性口令 |
| 维护词条 | `admin/lexical-entries` | 搜索/创建全局词条，查看来源溯源 |
| 导入词表 | `admin/imports` | 多格式上传 → 解析校验 → 提交有效行 → 错误报告 |
| 审核补全 | `admin/reviews` | 审核 Wiktionary/DeepSeek 补全草稿（接受/改后接受/驳回） |
| 课程编排 | `admin/courses/{id}/draft` | 编辑单元/词项、排序（带乐观版本 `If-Match`，陈旧变更返回 `409`） |
| 发布 | `admin/courses/{id}/releases` | 校验就绪 → 创建不可变发布（需幂等键与精确草稿版本）；可移动当前发布指针回旧版 |
| 会员管理 | `admin/memberships` | 会员 CRUD（授予/续期/撤销，状态由服务端推导） |
| 运营作业 | `admin/operations` / `operations/jobs` | 查看作业状态/进度/错误，幂等重试失败作业 |

- **发布约束**：草稿变更需 `If-Match` 或显式 `draftVersion`；发布需幂等键与精确已校验草稿版本。已发布 release 行拒绝更新/删除（触发器或仓库守卫）。
- **一次性口令**仅返回一次，不写入日志/审计 payload。
- **挑战积分调整**（`admin/game/challenge-score-adjustments`）：追加经审计的作废/补偿事实，永不就地改写总分或答题。

---

## 8. 功能模块详解

### 8.1 内容供应链（手工 + 管线）

- **手工闭环（已完成）**：词条 → 课程草稿/单元/词项编排 → 校验 → 不可变发布 → 目录与报名 → 主课程。
- **内容管线（进行中，阶段 6）**：四格式导入（TXT/CSV/XLSX/JSON）→ 存储原始文件 → 逐行校验 → Wiktionary 适配器补全 → DeepSeek 中文草稿 → 人工审核 → 词条落地。每步都可重试、保留来源溯源（provenance）与拒绝路径。
- **不可变发布（ADR-0003）**：草稿发布后形成不可变快照，修订必须产生新发布版本；坏发布通过移动当前指针回旧版修复，**不编辑快照**。

### 8.2 学习核心（FSRS v6，双卡，幂等）

- **双向独立卡（ADR-0004）**：每张卡只携带一个方向，两方向调度状态互不污染。
- **FSRS v6 适配器**：参数版本化、确定性时钟、Again/Hard/Good/Easy Fixture 与到期计算可单测。
- **每日计划**：过期优先于到期优先于新词；排除锁定单元；用时间预算填充；无任务返回空。
- **会话恢复**：服务端拥有会话，刷新恢复活跃会话，不重复计分。
- **单元解锁**：当前单元所有词项完成双向首测后下一单元解锁（读模型可缓存但可重建）。

### 8.3 激励与周挑战（客观积分）

- **XP 与等级**：合格复习/首测事件固定 5 XP，评分不乘系数；等级/任务/连续天数/徽章均按版本化规则集计算。
- **连续天数与保护**：按用户时区本地日；每连续 7 天获一次自动保护，漏学日符合条件自动消耗。
- **客观周挑战（ADR-0007）**：挑战积分与日常 XP **严格分离**——挑战积分只来自服务器判分的 10 题测验，跨课程同词同方向一周仅一次（首次答对 5 分）。**周榜只按挑战积分排名，日常 XP/速度/难度均不参与**。结算 `floor(points/10)` 成长 XP，上限 200。
- **诚实排名**：同分先达到当前分者在前，再按用户 ID；退出公开榜者仍保留个人积分与奖励资格。

### 8.4 运营与作业（Operations）

- Graphile Worker 跑后台任务；API 通过 `operations/jobs` 暴露脱敏状态、进度、尝试与最后安全错误；失败作业可幂等重试。
- 原始 Graphile 表与供应商 payload **永不直曝**；外部调用记录带幂等键、请求哈希、供应商/模型/版本、脱敏响应哈希。
- 供应商可中断：真实 Wiktionary/DeepSeek 故障只暂停相关队列，已发布内容与学习/XP 仍可用。

### 8.5 会员体系（当前实现，超越文档基线）

> 原始 `PRODUCT.md` 与 `DESIGN.md` 曾声明不设计会员/付费身份。当前代码已包含会员领域模块（`packages`/`modules/membership`）、`free`/`member` 计划、每日学习时长上限（迁移 `0045_membership_daily_limit`、`0046_challenge_daily_usage`）、管理员会员管理页（`admin/memberships`）与学习者端会员徽标。

- **两级方案**：`free`（免费方案，有每日学习时长上限）/ `member`（会员，今日不限时）。
- **状态由服务端推导（fail-closed）**：无会员行或 plan≠member → 免费；plan=member 且服务端判定生效 → 会员；否则过期 → 按免费限制处理。前端显示文案集中在纯函数（`membership-display.ts` / `membership-utils.ts`），不可伪造。
- **每日时长**：免费方案显示「今日剩余 N 分钟 · 明日重置」；非会员的复习/测验也计入每日使用时长（见近期提交「非会员排行榜测验计入每日使用时长」）。
- **管理端**：会员 CRUD（授予/续期/撤销），三元徽标态 `免费 / 会员 / 已过期`。

---

## 9. 设计语言速览

完整规则见 [`DESIGN.md`](../../DESIGN.md) 与 [`docs/ui/web-ui-spec.md`](ui/web-ui-spec.md)。要点：

- **唯一非语义强调色是品牌橘橙 `#F5781F`**：只用于每决策区唯一主操作、链接、当前导航、有限高价值进度信号。状态色只表达成功/警示/错误，不可借橘橙伪装为状态。
- **浅色主题优先**：首版只做精致浅色；不用装饰渐变、霓虹、AI 插画、吉祥物。
- **每页一个主任务**：禁止卡片套卡片、装饰大标题、无意义统计块、悬浮 FAB、多个竞争性主按钮。
- **Liquid Glass 是功能性前景层**（非全页风格）：用于导航/工具栏/底部 Dock/侧栏/顶栏（默认 `regular` 材质，靠「背景参与→半透明基底→内外细边→克制阴影」表达厚度）；学习内容/卡片用不透明标准面。必须在 `prefers-reduced-transparency`、不支持 `backdrop-filter`、高对比下回退为高对比实色表面。
- **图标**：锁定版本 Motro Icon Set（以 Lucide 为基底、经审查同概念变体），不混库、不用 Emoji/AI 图标；实心仅表已选/已完成/受强调状态。
- **动效是状态变化的语法**：因果、连续、精确、不中断、高频更安静；优先 `transform`/`opacity`，尊重 `prefers-reduced-motion`。学习卡推进 180–260ms，按压 80–120ms，不使用彩纸/爆闪/玩具回弹。
- **真实性数据**：指标定义/去重/能力标签在 [`docs/ui/learner-dashboard-metrics.md`](ui/learner-dashboard-metrics.md)。图表只在表达趋势/构成/比较时使用，且必有结论式标题、单位、时间范围与文本摘要。

---

## 10. 本地开发与运行

### 环境要求

- **Node.js 22.x**（`.nvmrc` 固定为 `22`，推荐 nvm）
- **pnpm**（由 Corepack 管理，版本见根 `package.json` 的 `packageManager`，当前 `pnpm@9.15.0`，无需全局安装）

### 安装与工具链

```sh
corepack pnpm install      # 依赖经 .npmrc 走 npmmirror 镜像

pnpm format    # Prettier 检查
pnpm lint      # ESLint
pnpm typecheck # 严格 tsc --build
pnpm test      # Vitest（允许无测试文件）
pnpm build     # 编译全部 workspace 包
```

> 若 Corepack 拉取 pnpm 本身需走镜像：`COREPACK_NPM_REGISTRY=https://registry.npmmirror.com corepack pnpm install`

### 数据库与常用脚本

```sh
pnpm db:migrate          # 对 .env 指向的库执行有序迁移
pnpm db:migrate:check    # 校验迁移（连受控测试库，不碰生产）
pnpm db:bootstrap-admin  # 创建首个管理员（需 BOOTSTRAP_ADMIN_USERNAME/PASSWORD 与库连接变量）
pnpm config:check        # 校验运行时配置
pnpm openapi:generate    # 从控制器生成 OpenAPI
pnpm openapi:check       # OpenAPI 与已提交产物 diff
pnpm openapi:types       # 由 openapi.json 生成客户端类型
```

### 本地启动（Compose 开发栈）

`compose/docker-compose.yml` 提供 `db`、`api`、`worker`、`web`。开发环境示例见 `.env.example`（PostgreSQL `motro`/`motro`/`dev_only_change_me`，会话/CSRF 占位键，`COOKIE_SECURE=false`）。Worker 默认并发 1（最大 2）、poll 2s、lease 60s、崩溃恢复扫描 2s；导入文件根 `.local-import-files`，单文件 ≤10MB，支持 txt/csv/json/xlsx。

---

## 11. 部署指南

### 11.1 家庭服务器部署（设计基线，ADR-0006）

- x86_64 Linux，4 GB RAM 目标（日常约 5 人，容量证据覆盖 20 用户/10 万词项/100 万复习事件）。
- 通过 **Tailscale HTTPS** 私有访问，v1 无公网入口。
- 仅发布在 Tailscale/私有网卡；PostgreSQL 与 worker 无公网端口；CORS 限制到 Motro 源；防火墙拒绝非请 WAN。
- **部署顺序**：校验架构/磁盘/内存/时钟/Tailscale → 拉固定镜像摘要或构建打标签私有库 → 备份 → 仅启动 PostgreSQL 并跑一次迁移 → 启动 API/Worker/Web → 等就绪 + 认证冒烟 + 查作业队列年龄 → 保留旧镜像与备份至观察窗口。
- **备份**：每日一致性检查点后做 PostgreSQL 逻辑 dump、归档配置与原始/必要内容文件（SHA-256 清单）、加密后复制到独立磁盘/NAS（解密密钥不随备份存放），保留 30 个日恢复点；每月在隔离环境恢复演练。
- **故障手册**：API/Web 重启（已接受复习事件持久，浏览器恢复会话）；Worker 重启（至少一次重试）；供应商中断（暂停相关队列）；坏发布（移动当前指针回旧不可变版）；库丢失（隔离→空兼容 PostgreSQL→恢复最新已验证备份→校验→重开）。

### 11.2 内网正式上线（小白说明书）

详见 [`docs/deployment/intranet-beginner-deployment-guide.md`](deployment/intranet-beginner-deployment-guide.md)。关键步骤：

1. **准备**：内网 Linux 服务器（4C/8G 起，50GB+ 系统/应用盘，另留数据库与备份空间）、固定私网 IP/内网域名、私有 CA TLS 证书、两个 32+ 字符随机密钥（`SESSION_KEY`/`CSRF_KEY`）、PostgreSQL 强口令、首个管理员凭据、独立备份盘。
2. **审计上线代码包**：`git clone` 干净仓库 → `git checkout <RELEASE_REF>` → 跑放行检查（`pnpm install --frozen-lockfile && typecheck && lint && build && format:check && openapi:check && db:migrate:check && test`）。所有命令必须成功。
3. **服务器首次准备**：建目录（权限严格）、创建 `intranet.env`（chmod 600，**不 source**，只交给 `docker compose --env-file`）、`docker compose config --quiet` 验证展开。先保持 `MOTRO_PROVIDER_MODE=fake`、`DEEPSEEK_ENABLED=false`。
4. **重要审计结论**：`compose/intranet.yml` 启动 `db`/`worker-migrate`/`api`/`worker`/`web`，**不含 `proxy` 服务**。运维须自行把 Caddy（配置样例见 `compose/intranet/proxy/Caddyfile`）加入同 Docker 网络或宿主机，绑定私网 IP，只读挂载证书私钥；`PROXY_BIND_ADDR` 改成服务器私网 IP，防火墙仅放内网 443。
5. **严格按顺序启动**：`build` → `up -d db` 等 healthy → `up --wait worker-migrate`（最关键）→ **动态核对迁移版本**（从 `db/migrations` 读最高版本，与库 `schema_migrations.max(version)` 比对，**两数字必须相同**）→ `up -d api worker web`。
6. **创建首个管理员**：`BOOTSTRAP_ADMIN_USERNAME/PASSWORD` + `pnpm db:bootstrap-admin`（从环境读库连接）。
7. **最小验收**：首页 200、登录表单、管理员登录、管理端可访问课程/用户/会员/审核、新建学习者无法访问管理端、登出回登录页、跨设备登录。
8. **真实 provider（第二阶段）**：先 fake 稳定并通过验收；改 `MOTRO_PROVIDER_MODE=real`/`DEEPSEEK_ENABLED=true`/`MOTRO_WIKTIONARY_ALLOW_NETWORK=true` + 真实密钥与白名单，仅重建 `api worker`。真实 provider 不可达不应影响登录/课程/学习/XP；相关导入/富集任务进入运维队列。
9. **每日备份 + 每月恢复演练**；升级走「小版本发布」流程（先已验证备份 → 停 api/worker 留 db → 切批准提交 → build → worker-migrate + 版本核对 → 起服务 → 冒烟）。
10. **禁止快捷修复**：`docker compose down -v`、`git reset --hard`、手改 `schema_migrations`、改已生产迁移、为过检关掉安全校验/TLS/CSRF。

### 11.3 导入 E2E（独立数据库隔离）

`tests/e2e/admin-imports.spec.ts` 产生**不可变** commit facts（`BEFORE DELETE` 触发拒绝删除），因此**必须跑在独立数据库**上。一键 runner：

```sh
E2E_ADMIN_PASSWORD=<管理员引导口令> pnpm run e2e:import
```

自动执行：启动独立栈（`compose/e2e-import.yml`，端口 3100/3101、库 5433）→ 迁移独立库（强制 `127.0.0.1:5433` + `E2E_POSTGRES_*` 命名空间，绝不碰共享 `motro` 栈）→ 跑 `admin-imports`/`admin-operations`（Chromium+WebKit 并发，各用独立管理员与 storageState）→ **无论成败/中断都 `down -v`** 清理。独立栈凭据与共享栈完全隔离，不可变事实由整体销毁卷处理，绝不绕过触发器删除。手动逐步命令见 [`README.md`](../../README.md)。

---

## 12. 测试与质量门禁

原则：最深入测试不可变领域事实与契约；时间/随机/调度参数/供应商响应必须可注入且确定性；每个生产缺陷在最低有效层补最窄回归测试。

### 分层

- **领域测试**：双独立卡、FSRS v6 各档 Fixture、21 天稳定边界、单元解锁、每日计划排序、游戏规则（5 XP 不乘系数、时区 streak/保护）、挑战规则（北京周/关门、10 不同词条、跨课程去重、首答对 5 分、同键不同语义 409、首达分同分排序）、挑战判分（归一化/精确空格/仅别名）、挑战结算（`floor(points/10)`、200 上限、幂等、退出仍奖励、作废/补偿追加事实）。
- **PostgreSQL 集成**：并发重复 `ReviewEvent` 只一条；同幂等键改体冲突；失败回滚全部效果；挑战作答事务验证周/到期/锁快照/并发至多一条 score；发布行拒绝变更；草稿乐观版本冲突可见；Graphile 任务 at-least-once 不重复应用结果；迁移从空库与每历史版本跑通。
- **导入测试**：TXT/CSV/XLSX/JSON × BOM/编码/多表/自定义映射/重复/空白/畸形/大文件/恶意文件名内容；供应商 fixture 覆盖缺失/歧义/修订/空/无效/限流/重试/人工编辑接受驳回/来源保留。**不调用真实 Wiktionary/DeepSeek**（独立 gated 冒烟除外）。
- **API/安全**：OpenAPI 与已提交产物匹配、破坏性 diff 失败；角色/所有权矩阵每端点（含隐藏资源 `404`）；Cookie 标志、会话轮换/撤销、首登改密、CSRF/源校验、登录限速、禁用用户；上传限制/MIME/路径穿越/存储 XSS/注入/密钥日志脱敏；错误信封、请求 ID、分页稳定、时间序列化。
- **E2E（Playwright，Chromium+WebKit）**：登录/改密、选主课、创建恢复会话/学新词/双向首测/到期复习、提交前后刷新无重复 XP、结果/资料/周榜、解锁/开挑战/选择+拼写作答/即时反馈/刷新重试/超时/结果/退出、管理员建账号、四格式导入/错误/审核、编排校验发布/学习者见正确发布、失败作业检查与幂等重试。
- **UI/可访问性**：390/768/1440 关键态截图基线；axe 自动 + 键盘/焦点恢复/200% 缩放/读屏/reduced-motion 抽查；无横向溢出、44px 触控区、逻辑标题/地标、AA 对比；人工审查拒绝装饰渐变/玻璃拟物/嵌套卡片/Emoji/陌生导航/无意义对话框/竞争性主操作。
- **性能/容量**：种子 20 用户/10 万词项/100 万复习事件，测 4GB 类资源；学习读 p95<500ms、复习写 p95<700ms、核心路径无全扫、无丢失/重复事件、DB 池有界、导入不饿死学习流量。
- **部署验证**：Compose 冒烟覆盖全新安装/迁移/重启/就绪/Tailscale 路由/备份清单加密/空环境恢复；发布前恢复演练须证明登录、已发布内容、复习历史、XP、必要导入文件可用。

### CI 门禁顺序

格式化/lint → typecheck → 域/单测 → 库/集成 → OpenAPI diff → build → Playwright/视觉/a11y。供应商冒烟、容量、恢复演练按需/夜间跑，非每提交。

---

## 13. REST API 速览

完整契约见 [`docs/api/rest-api.md`](api/rest-api.md) 与生成的 [`docs/generated/openapi.json`](generated/openapi.json)。要点：

- **基路径** `/api/v1`，JSON UTF-8；浏览器用 Secure/HttpOnly 会话 Cookie 认证，不安全方法须同源/CSRF 保护。
- **时间戳** RFC 3339 UTC；本地日期 `YYYY-MM-DD` + 时区。
- **ID** 不透明 UUID，客户端不得从 ID 推断顺序/类型。
- **幂等键** `Idempotency-Key`：复习提交、发布、账号创建/重置、显式作业重试必需；服务端按 actor/操作域化并持久化。
- **错误信封**：`{ error: { code, message, requestId, fieldErrors?, retryable } }`；状态码 `400/401/403/404/409/422/429/503`，绝不返回栈或供应商密钥。

按模块分组的端点（节选）：

| 模块 | 代表端点 |
| --- | --- |
| Auth | `/auth/login` `/auth/logout` `/auth/me` `/auth/change-password` `/auth/sessions` |
| Catalog | `/catalog/courses` `/catalog/courses/{id}` `/enroll` `PUT /catalog/primary-course` |
| Study | `/study/today` `POST /study/sessions` `/sessions/{id}/reviews` `/reveal` `/abandon` `/result` |
| Game | `/game/summary` `/game/leaderboard/weekly` `/game/challenge/weekly` `POST /game/challenge/attempts` `/attempts/{id}/responses` `/result` |
| Profile | `GET/PATCH /profile` |
| Admin accounts | `GET/POST /admin/users` `GET/PATCH /admin/users/{id}` `/disable` `/reset-password` |
| Admin content | `GET/POST /admin/lexical-entries` `GET/POST /admin/imports` `/validate` `/commit` `/error-report` `GET /admin/reviews` `/decision` |
| Admin course | `GET/POST /admin/courses` `draft/units...` `draft/items...` `POST /releases` `PUT /current-release` |
| Membership | `admin/memberships` CRUD（当前实现） |
| Operations | `GET /operations/jobs` `GET /operations/jobs/{id}` `POST /operations/jobs/{id}/retry` `GET /operations/health-summary` |

**契约兼容**：v1 内新增可选字段/端点的向后兼容；枚举扩展可能被生成客户端视为破坏；移除/重命名字段、改义、收紧必填需 `/api/v2` 或文档化迁移窗口。契约测试比对生成 OpenAPI 并用生成客户端打 API。

---

## 14. 路线图与当前状态

> 阶段总览与当前执行门见 [`docs/project/current-status.md`](project/current-status.md)；工单以 `.scratch/<phase>/issues/` 为准。

| 阶段 | 状态 | 范围 |
| --- | --- | --- |
| 1. 规格基线 | 已完成 | 产品/领域/架构/API/测试/UI 基线 + 7 ADR |
| 2. 设计验证 | 基线已确认 | 关键页面原型、橘橙 Glass 方向、动效/材料规范 |
| 3. 平台基础 | 已完成 | monorepo/CI/Compose/PostgreSQL/Nest/Next/OpenAPI/配置/认证闭环 |
| 4. 手工内容闭环 | 已完成 | 词条/草稿/校验/不可变发布/目录/报名/主课程 |
| 5. 学习核心 | 已完成 | 双卡/FSRS v6/每日计划/可恢复会话/评分/进度/学习 Web |
| 6. 内容管线 | 进行中 | 四格式导入/存储/校验/Wiktionary/DeepSeek/人工审核/作业状态（8 张有序工单） |
| 7. 激励与运营 | 已规划 | 版本化规则/XP/等级/任务/streak/徽章/客观挑战/周榜/运营指标（11 张工单） |
| 8. 质量/设计/容量 | 已规划 | 响应式/可访问/跨浏览器/视觉回归/文案/安全/4GB 容量（9 张） |
| 9. 家庭服务器发布 | 已规划 | 固定镜像/Tailscale HTTPS/监控/健康/加密 30 天备份/恢复演练（9 张） |
| 10. 原生客户端发现 | 延后 | Web 稳定后单独立项，不继承 Web UI 实现，只继承产品行为/领域/REST 契约 |

> 注意：第 5–9 阶段部分功能（尤其会员体系、XP/周榜 VIP、每日使用时长上限）已在当前仓库**提前实现并合并**，超出 `current-status.md` 的阶段划分描述；以实际提交与代码为准。

### 架构决策记录（ADR）

1. Web 优先 + 平台无关 REST
2. TypeScript 模块化单体 + PostgreSQL + monorepo
3. 不可变课程发布
4. FSRS v6 + 双卡 + 幂等复习
5. Wiktionary/DeepSeek + 人工审核
6. Docker Compose + Tailscale + 家庭服务器
7. 客观周挑战积分与日常 XP 分离

---

## 15. 常见问题

**Q：学习者如何开始学习？**
A：登录 → 首页「开始学习」→ 进入当日会话（先复习到期，再学新词）→ 逐卡翻卡 + 四级评分 → 结束看结果。刷新会自动从服务端恢复，不重复计分。

**Q：管理员如何发布一门课程？**
A：导入/创建词条 → 在课程草稿编排单元与词项 → 校验就绪 → `POST /releases` 创建不可变发布（需幂等键与精确草稿版本）→ 学习者即可报名。

**Q：为什么周挑战榜不用我的 XP 排名？**
A：设计上有意把「客观答题活动量」（挑战积分）与「日常学习成长」（XP）分开。周榜只表达本周服务器判分的积分测验活动量，不宣称等同于英语能力。

**Q：已稳定是不是代表永久掌握？**
A：不是。它只是两张方向卡预计间隔均 ≥ 21 天的系统判定；是 Motro 调度下的派生事实，不能直接换算为 CEFR/考试分数/综合语言能力。

**Q：会员与非会员的区别？**
A：会员「今日学习不限时」；免费方案有每日学习时长上限（含复习与测验），次日重置。状态由服务端推导（fail-closed），前端不可伪造。

**Q：迁移失败了怎么办？**
A：不要启动 API/Worker，不要手改 `schema_migrations`，不要改已发布迁移文件，保留日志，修复原因后重跑迁移步骤（见内网说明书第 5.2 节）。

**Q：导入 E2E 能在共享开发库跑吗？**
A：不能。`admin-imports` 产生不可变 commit facts，必须用 `pnpm run e2e:import` 在独立隔离栈跑，结束后 `down -v`。

**Q：可以把 Caddy/真实 AI 先关着吗？**
A：可以且推荐。先以 `MOTRO_PROVIDER_MODE=fake`、`DEEPSEEK_ENABLED=false` 稳定跑通，再由负责人批准后开启真实 Wiktionary/DeepSeek（仅重建 api/worker）。真实供应商不可达不影响登录/课程/学习/XP。

---

## 16. 参考文档索引

**顶层**
- [`PRODUCT.md`](../../PRODUCT.md) — 产品承诺、用户、v1 边界
- [`CONTEXT.md`](../../CONTEXT.md) — 领域术语（权威词汇）
- [`DESIGN.md`](../../DESIGN.md) — 设计方向（最高优先级视觉约束）
- [`AGENTS.md`](../../AGENTS.md) — 本地 issue/领域文档约定
- [`README.md`](../../README.md) — 工具链与导入 E2E 说明
- 产品规格 `.scratch/motro/spec.md`

**docs/**
- 架构：[overview.md](architecture/overview.md) · [data-model.md](architecture/data-model.md)
- API：[rest-api.md](api/rest-api.md) · [generated/openapi.json](generated/openapi.json)
- 部署：[home-server.md](deployment/home-server.md) · [intranet-beginner-deployment-guide.md](deployment/intranet-beginner-deployment-guide.md) · [intranet-deployment-checklist.md](deployment/intranet-deployment-checklist.md) · [intranet-runbook.md](deployment/intranet-runbook.md) · [backup-restore.md](deployment/backup-restore.md) · [intranet-env.example](deployment/intranet-env.example)
- 测试：[testing/strategy.md](testing/strategy.md)
- 项目：[roadmap.md](roadmap.md) · [project/current-status.md](project/current-status.md) · [project/decisions.md](project/decisions.md) · [project/execution-gates.md](project/execution-gates.md)
- UI：[web-ui-spec.md](ui/web-ui-spec.md) · [learner-dashboard-metrics.md](ui/learner-dashboard-metrics.md) · [motro-logo-system.md](ui/motro-logo-system.md) · [skill-security.md](ui/skill-security.md) · [surfaces/README.md](ui/surfaces/README.md)（含 learner 与 admin 各界面 brief）
- ADR：[adr/README.md](adr/README.md)（0001–0007）
- 运维：[operations/monitoring.md](operations/monitoring.md)
- Agent：[agents/issue-tracker.md](agents/issue-tracker.md) · [agents/triage-labels.md](agents/triage-labels.md) · [agents/domain.md](agents/domain.md)

**代码入口**
- 学习者端：`apps/web/src/app/(learner)/`（home/courses/study/challenge/leaderboard/profile 等）
- 管理端：`apps/web/src/app/admin/`（users/lexicon/imports/reviews/courses/memberships/operations/motivation/xp 等）
- API：`apps/api/src/modules/`（auth/catalog/study/game/admin/operations/membership/motivation/reviews）
- Worker：`apps/worker/src/`（task-list、operation-executor、recovery-scan、real/fake 适配器）
- 迁移：`db/migrations/`（有序 SQL，当前至 0046）

---

*本手册汇总自上述权威文档与 2026-08 仓库代码，旨在降低阅读门槛。当本文与权威约束冲突时，以 `PRODUCT.md`/`CONTEXT.md` → `DESIGN.md` → `docs/` → 已提交代码 的优先级为准。*

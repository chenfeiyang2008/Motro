# Motro 内网部署清单（Ticket 11）

> 本文是**部署前/中/后核对清单**。可执行步骤见 [`intranet-runbook.md`](intranet-runbook.md)；
> 备份/恢复见 [`backup-restore.md`](backup-restore.md)；运维监控见 [../operations/monitoring.md](../operations/monitoring.md)。
> 除特别标注 UNVERIFIED 外，以下命令均在本仓库可读源码/已跑通的 verify.sh 中验证过。

- 版本基线：本文档对齐仓库当前源码，迁移目标为 **0045**（`db/migrations/0045_membership_daily_limit.sql`）。
- 所有路径 / 域名 / 证书 / 口令为占位符；真实值由 Owner 填写（见文末「Owner 待填写项」）。
- **不写入真实密钥到仓库**；示例一律使用 `<请填>` 占位符。

---

## 0. 目标与边界

| 项 | 值 |
|---|---|
| 部署范围 | 内网 web / api / worker / postgres + 反向代理（Caddy） |
| 默认出网 | 关闭（fake provider；不访问真实 Wiktionary / DeepSeek） |
| 浏览器入口 | 仅反向代理；API/Web/Postgres/Worker 不直接对外 |
| 数据 | `db-data` 命名卷（`docker compose down` 不删；`down -v` 才删） |
| 迁移 | `worker-migrate` 一次性前置；失败则 api/worker 不启动 |

---

## 1. 部署前检查清单

### 1.1 环境

- [ ] 主机为 Linux（推荐）或 macOS；64 位；能长期稳定运行。
- [ ] Docker Engine ≥ 24 与 Docker Compose v2（`docker compose version` 输出 `v2.x`）。
- [ ] `docker buildx` 可用（镜像需多阶段构建）——主机可构建；部署也可从受信私有源拉镜像。
- [ ] 有仓库源码访问权（构建时把 `db/migrations` 打包进镜像）。

### 1.2 资源最低建议

- [ ] CPU ≥ 2 核（worker 并发 1，API/web 峰值）；4 核更稳。
- [ ] 内存 ≥ 4 GB（依据工单 04 预算；DB 默认值 + worker 单进程）。
- [ ] 磁盘 ≥ 20 GB 可用（`/var/lib/docker` 与备份卷各一块独立盘更佳）。
- [ ] 检查命令：`uname -a`、`free -h`、`df -h /var/lib/docker`。

### 1.3 时区与时间同步

- [ ] 主机时区已设（`timedatectl` 或 `date`）。
- [ ] NTP / chrony 同步开启；`timedatectl` 显示 `System clock synchronized: yes`。
  - 理由：worker lease（默认 60s）与操作 attempted 时间戳依赖系统时钟一致性；时钟漂移会让
    lease 过期/恢复扫描误判。

### 1.4 防火墙与内网访问范围

- [ ] 仅内网网卡开放：Caddy → 443/80（浏览器）；API → 3000；Web → 3001；Postgres → 5432。
- [ ] 禁止对公网开放上述端口（`firewall-cmd` / `ufw` / 云安全组）。
- [ ] 学习者浏览器可访问内网域名（DNS / hosts 指向内网主机）。
- [ ] 管理员维护通道（SSH）有独立访问控制（非 0.0.0.0）。

### 1.5 Docker 持久化卷

- [ ] 命名卷 `db-data` 位于磁盘空间充足的路径，**不与备份同盘**。
- [ ] 卷说明：`docker compose down` 保留；`down -v` 删除（不可恢复）。
- [ ] `docker system df` 检查无异常增长。

### 1.6 TLS 证书与私有域名

- [ ] 内网域名已在 DNS / hosts 解析（`<intranet-host>`）。
- [ ] 已准备私钥 + 证书（自签或私有 CA）；路径、权限（`0600` 密钥）、可挂载性已确认。
- [ ] Caddy `auto_https off` + `tls { cert_file/key_file }`（见 `compose/intranet/proxy/Caddyfile`）。

---

## 2. 环境变量清单

每项均为 `intranet.env` 或 shell 环境注入；required 项缺省 fail-fast（`${VAR:?}` 语义）。
完整占位模板见 [`intranet-env.example`](intranet-env.example)。

### 2.1 数据库凭据（required）

| 变量 | 必填 | 说明 |
|---|---|---|
| `POSTGRES_DB` | ✅ | 内网专用库名，勿与共享 `motro` 混用 |
| `POSTGRES_USER` | ✅ | DB 超级用户或专用用户 |
| `POSTGRES_PASSWORD` | ✅ | 强口令；禁止 `dev_only_change_me` |
| `POSTGRES_HOST/PORT` | 默认 `db`/`5432` | 容器网络内服务名；不直连公网 |

### 2.2 Cookie / CSRF（required，32+ 随机）

| 变量 | 必填 | 说明 |
|---|---|---|
| `SESSION_KEY` | ✅ | 32+ 字节随机；`config.ts` 校验 `min(32)` |
| `CSRF_KEY` | ✅ | 32+ 字节随机；同上 |
| `COOKIE_SECURE` | ✅ | `production` 强制 `true`；否则启动报错 |
| `COOKIE_SAMESITE` | 默认 `lax` | 内网同源；跨域才需要 `strict`/`none`（`none` 必须配 secure） |
| `COOKIE_IDLE_MINUTES` / `COOKIE_ABSOLUTE_HOURS` | 可选 | 会话空闲/绝对时长 |
| `CSRF_HEADER_NAME` | 默认 `x-csrf-token` | 一般无需改 |

> **E2E_ADMIN_PASSWORD 仅测试使用，禁止写入生产配置。** 生产管理员账号用独立引导流程
> （见 [`intranet-runbook.md`](intranet-runbook.md) §11「引导首个管理员账号」）。

### 2.3 API / Web 绑定

| 变量 | 说明 |
|---|---|
| `API_PORT=3000` / `WEB_PORT=3001` | 容器内部端口（compose 内固定） |
| `API_BIND_ADDR` / `WEB_BIND_ADDR` | host 绑定地址；默认 `127.0.0.1`，浏览器走 Caddy |
| `API_BIND_PORT` / `WEB_BIND_PORT` | host 绑定端口；默认 `3000`/`3001` |
| `API_PUBLIC_URL` | 浏览器可见的 API origin（反代后同源 `/api/v1`） |
| `WEB_PUBLIC_URL`（required） | 浏览器主页 origin；空值 fail-fast |
| `API_INTERNAL_URL` | 容器网络内 `http://api:3000`；web 容器与构建期同源 rewrite 使用 |
| `CORS_ORIGINS`（required） | 仅反代 origin，逗号分隔；不要 `*` |

### 2.4 Worker 参数

| 变量 | 默认 | 上限 |
|---|---|---|
| `WORKER_CONCURRENCY` | `1` | ≤2（4GB 预算） |
| `WORKER_MAX_POOL_SIZE` | `2` | 固定 `2` |
| `WORKER_MAX_ATTEMPTS` | `5` | ≤5 |
| `WORKER_POLL_INTERVAL_MS` | `2000` | — |
| `WORKER_LEASE_MS` | `60000` | ≥600（配合 200ms 心跳） |
| `WORKER_RECOVER_INTERVAL_MS` | `2000` | 500–5000 |
| `WORKER_RECOVER_BATCH_SIZE` | `20` | ≤20 |

### 2.5 Provider 网络开关（T22）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MOTRO_PROVIDER_MODE` | `fake` | `fake` = 注册 fake handler（零网络）；`real` = 注册真实 Wiktionary/DeepSeek adapter；不允许静默混用 |
| `DEEPSEEK_ENABLED` | `false` | `true` 时 real 模式注册真实 DeepSeek adapter；production 缺 `DEEPSEEK_API_KEY` fail-fast |
| `MOTRO_WIKTIONARY_ALLOW_NETWORK` | `false` | `true` 时 real 模式允许真实 Wiktionary 网络（否则 handler 抛 WIKI_TRANSIENT fail-closed） |

> **当前状态（T22 已落地）**：worker 按 `providerMode` 注册——`fake` 模式用
> `buildFixtureHandler + buildWiktionaryFakeHandler + buildDeepSeekFakeHandler`；
> `real` 模式用 `buildWiktionaryRealAdapter + buildDeepSeekRealAdapter`。真实 adapter 具备
> SSRF 白名单（`MOTRO_WIKTIONARY_HOST_ALLOWLIST`）、HTTPS only、超时/大小上限、Content-Type
> 校验、fail-closed 许可缺失；所有日志脱敏（不记录 API Key / Authorization / prompt / 响应正文）。
> 启用真实 provider 需要 Owner 独立门（见文末清单与交付报告）。

### 2.6 导入文件 / 限速（可选，默认保守值）

见 [`intranet-env.example`](intranet-env.example)：`IMPORT_*`、`RATE_LIMIT_LOGIN_PER_MINUTE`、
`LOG_LEVEL`、`OPENAPI_ENABLED`（内网建议 `false`）。

---

## 3. 标准启动流程

完整命令在 [`intranet-runbook.md`](intranet-runbook.md)。执行者按序，任一步失败即停止并走 §4。

1. 创建部署目录；把 `intranet.env` 落在**仓库外**（如 `/srv/motro/intranet.env`）。
2. 从 `docs/deployment/intranet-env.example` 复制模板并填值。
3. **校验 compose config**：`docker compose -f compose/intranet.yml --env-file intranet.env config --quiet`。
4. **启动 db**：`docker compose ... up -d db`；`ps` 中 `healthy` 后再继续。
5. **执行 worker-migrate**（一次性）：
   `docker compose ... up --wait worker-migrate`（或 `up -d` + 观察 `logs worker-migrate` 退出码）。
6. **检查迁移 0001 → 当前最高（0045）**：
   `docker compose ... exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT max(version) FROM schema_migrations"` 应输出 `45`。
7. **启动 api / worker / web**：`docker compose ... up -d api worker web`。
8. **启动 Caddy**（反代）：在部署机运行 `compose/intranet/proxy/Caddyfile`（或独立 compose 服务）。
9. **检查 live / ready**：`curl -f http://127.0.0.1:3000/api/v1/health/live` 与
   `curl -f http://127.0.0.1:3000/api/v1/health/ready`（期望 `checks.db=ok` + `checks.graphileWorker=ok`）。
10. **浏览器访问**：首页 `<WEB_PUBLIC_URL>/` 200；登录页可渲染。

---

## 4. 迁移与失败处理

### 4.1 目标版本必须从源码动态确认

- 迁移目标**不是写死的数字**，而是 `db/migrations/` 目录下最大版本。
- 命令（在 db 容器执行）：
  ```sh
  docker compose -f compose/intranet.yml exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -tAc "SELECT max(version) FROM schema_migrations"
  ```
- 与 `ls db/migrations/ | sort -V | tail -1`（当前为 `0045_membership_daily_limit.sql` → 45）对照。

### 4.2 禁止跳过 migration

- `worker-migrate` 从 `0001` 顺序应用到当前最高；不允许手动 `INSERT` schema_migrations 跳过。
- 每个 migration 在自己的事务内执行；失败即回滚该文件并停止，返回非零退出码。
- 已应用文件的 `content_hash` 变化会抛错并**拒绝继续**（危险信号，见 §4.6）。

### 4.3 worker-migrate 失败时 api/worker 不得启动

- `api` 与 `worker` 的 `depends_on.worker-migrate: condition: service_completed_successfully`。
- 迁移失败 → worker-migrate 非零退出 → api/worker 保持不启动。
- 不要用 `docker compose up -d api worker web` 强行绕过；先修迁移。

### 4.4 不自动 destructive rollback

- 迁移执行器**不回滚旧迁移**、不做破坏性回滚（无 `down`/`reset`）。
- 失败恢复：对照 `docs/deployment/backup-restore.md`，从最近已验证备份恢复。
- 恢复流程：停 api/worker → 在隔离空卷重建 schema → 导入 dump → 验证 → 再启动。

### 4.5 备份后人工恢复

备份与恢复命令见 [`backup-restore.md`](backup-restore.md)。关键点：
- 先做一致性 checkpoint 再 dump（`pg_dump --format=custom`）。
- 备份 = 可恢复的产物（dump + 配置 + 原始导入文件 manifest），仅在文件存在 ≠ 通过。
- 恢复演练在隔离空环境做；成功才记录时长与证据。

### 4.6 schema_migrations hash drift 处理

- **drift 定义**：`schema_migrations.content_hash` 与本地 `db/migrations/` 文件 SHA-256 不一致。
- 检测命令：`pnpm db:migrate:check`（`packages/db/src/cli-migrate-check.ts`），报告
  `pending` / `drift` / `extra` 三类。
- 触发时：**停 api/worker** → 排查是哪个 migration 被改（`git diff` 对照源码）→
  确认改的是「已发布版本的迁移文件」还是源码中的新文件 → 恢复正确版本后再迁移。
- 禁止：手动 UPDATE 数据库 `schema_migrations.content_hash` 去"对齐"（会掩盖事实）。
- `extra`（数据库有但本地无）常见于多分支工作流；确认后走备份/重建决策，不直接删记录。

---

## 5. 反向代理与安全

配置示例：`compose/intranet/proxy/Caddyfile`。要点：

- **内网绑定**：`default_sni <intranet-host>`、`admin off`、`auto_https off`；
  只监听内网网卡（`PROXY_BIND_ADDR`）。
- **TLS 证书占位符**：`tls { cert_file ${TLS_CERT_FILE} key_file ${TLS_KEY_FILE} }`；真实路径由部署者提供。
- **健康检查边界**：只允许内部探活路径 `/api/v1/health/*`，不对外暴露后端细节。
- **业务路由分区**：`/api/v1/*` → `reverse_proxy api:3000`；其余 → `reverse_proxy web:3001`。
- **不暴露**：PostgreSQL、Graphile Worker、内部 worker 端口一律不配 host 端口；
  api/web 默认只绑 `127.0.0.1`。
- **安全响应头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、
  `Referrer-Policy: strict-origin-when-cross-origin`、移除 `Server`。
- **请求体限制**：`request_body { max_size 21MB }`（对齐 `@fastify/multipart` 20MB 上限；
  导入文件走 API 侧自有校验）。
- **CORS / Cookie**：`CORS_ORIGINS` 仅允许反代 origin；`COOKIE_SECURE=true`（production 强制）；
  `COOKIE_SAMESITE=lax`（同源）。
- **fake-only 默认零真实网络**：`MOTRO_PROVIDER_MODE=fake` → worker 注册 fake handler；
  真实 adapter 仅当 `real` 模式 + 显式开启网络时才调用。启用真实 provider 需 Owner 门。

---

## 6. 备份与恢复

完整 runbook：**[`backup-restore.md`](backup-restore.md)**。本文只列验收要点：

- [ ] 每日 PostgreSQL 逻辑 dump（custom 格式）+ 完整性校验（`pg_restore -l`）。
- [ ] 配置文件与原始导入文件打包 + **SHA-256 manifest**。
- [ ] **加密**备份产物（openssl AES-256-CBC，密钥文件绝不与备份同盘）。
- [ ] **备份保留周期**可配置（默认 30 天，`find -mtime` 清理）。
- [ ] **恢复演练**：隔离空卷重建 → 导入 dump → schema 版本对齐、manifest 哈希比对、
      登录、课程读取、一笔非生产 study 事务成功；记录时长与证据。
- [ ] 恢复后**重新执行 health / migration / test smoke**：
      live/ready、`max(version)=45`、`verify.sh`（隔离卷）。
- [ ] **明确禁止未经确认删除生产数据**：`down -v` 不可逆；只可在 Owner 确认后执行。

---

## 7. 上线验收清单（fake-only 内网演示）

以下每项需实测并勾选；无法实测的标 `UNVERIFIED`。

- [ ] **compose config**：`docker compose -f compose/intranet.yml --env-file intranet.env config --quiet` 通过。
- [ ] **migration check**：`max(version) FROM schema_migrations == 45`；`db:migrate:check` 无 pending/drift/extra。
- [ ] **API live/ready**：`/api/v1/health/live` 200；`/ready` 200 且 `checks.db=ok`、`checks.graphileWorker=ok`。
- [ ] **web 200**：`<WEB_PUBLIC_URL>/` 返回 200。
- [ ] **worker 存活**：`docker compose ps worker` 为 `Up`；日志无连续错误；队列可写（`graphile_worker.jobs` 可查询）。
- [ ] **登录 / 退出**：首页→登录页→用引导 admin 登录→退出。
- [ ] **管理端首页**：`/admin` 可渲染，无 5xx；侧边栏导航可见。
- [ ] **用户管理**：`/admin/users` 列表加载、可创建/编辑用户。
- [ ] **会员管理**：`/admin/memberships` 列表与发放/续期/撤销操作可用。
- [ ] **课程列表分页**：`/admin/courses` 分页正常。
- [ ] **审核和发布**：管理员可进入草稿审核、发布课程（fake provider 走内置 fixture）。
- [ ] **激励文案**：`/admin/motivation` 文案编辑与预览生效。
- [ ] **学习端课程**：学习者 `/courses` 课程列表、`/study` 学习流程可用。
- [ ] **XP**：学习者 XP 累积 / 页面展示正确。
- [ ] **排行榜**：`/leaderboard` 渲染，无 5xx。
- [ ] **挑战**：`/challenge` 答题流程可用，挑战得分入账。
- [ ] **非会员剩余时长**：非会员每日剩余时长按 `daily_budget_minutes` 显示。
- [ ] **备份任务**：手动触发一次备份，产物可 `pg_restore -l` 校验、manifest 哈希匹配。
- [ ] **日志和磁盘监控**：`docker logs` 正常轮转；`df -h` 未触发阈值；访问日志有 JSON 输出。

> 验收脚本：`compose/intranet/verify.sh`（隔离 fresh-volume smoke：compose config、
> live/ready、迁移最高版本 ≥ 45、worker 存活、队列可写、web 可达）。

---

## 8. 上线后监控

运维实现见 [../operations/monitoring.md](../operations/monitoring.md)。持续盯以下信号：

| 信号 | 探测方式 | 告警建议 |
|---|---|---|
| **API 5xx** | `docker logs` / `/api/v1/health/*` 状态 | 任一 5xx 告警；异常堆栈上报 |
| **ready 失败** | `/api/v1/health/ready` 返回 503 | 连续 3 次失败告警；区分 DB vs graphileWorker |
| **migration 失败** | `worker-migrate` 日志 / `db:migrate:check` | 立即告警；api/worker 不启动 |
| **worker queue 堆积** | `SELECT count(*) FROM graphile_worker.jobs WHERE locked_by IS NULL AND run_at <= now()` | 积压持续增长或单任务 age 超阈值 |
| **磁盘空间** | `df -h /var/lib/docker` | >80% 或剩余 <2GB 告警 |
| **PostgreSQL 连接数** | `SELECT count(*) FROM pg_stat_activity` | 接近 `max_connections` 80% |
| **日志轮转** | logrotate 状态 / journal | 日志不轮转即告警 |
| **备份失败** | 最新已验证备份年龄 > 36h | 立即触发备份 / 恢复演练 |
| **provider 网络开关状态** | 环境变量核对 + 日志 | 若未启用真实 provider，应恒为 false/fake |

---

## 9. Owner 待填写项（部署前必须确认）

| 项 | 占位符 | 说明 |
|---|---|---|
| 内网域名/IP | `<intranet-host>` | DNS/hosts 已解析；私有 CA 证书颁给该名 |
| TLS 证书路径 | `${TLS_CERT_FILE}` / `${TLS_KEY_FILE}` | 证书 + 私钥；权限 `0600`；可挂载 |
| API/Web 端口 | `3000`/`3001` | host 绑定端口；默认即可，按冲突调整 |
| PostgreSQL 数据目录 | `db-data` 命名卷 | `/var/lib/docker/volumes/motro-intranet_db-data` |
| 备份目录 | `/srv/motro-backups` | 独立磁盘/NAS；不与 DB 数据同卷 |
| 日志保留周期 | 默认 14 天轮转 | 按合规调整 |
| 是否允许外网访问 | 否（默认） | 本文档仅内网；公网上线需单独评估 |
| 是否启用真实 DeepSeek | 否（默认 fake） | `real` + `DEEPSEEK_ENABLED=true` + `DEEPSEEK_API_KEY`（secret 注入，不写仓库） |
| 是否启用真实 Wiktionary | 否（默认关网） | `real` + `MOTRO_WIKTIONARY_ALLOW_NETWORK=true` + `MOTRO_WIKTIONARY_HOST_ALLOWLIST` |
| 首个管理员账号 | `<请填>` | 用 `pnpm db:bootstrap-admin` 引导（见 runbook §7.2） |
| 维护窗口和联系人 | `<请填>` | 备份窗口、迁移窗口、on-call |

---

## 验收与状态

- **VERIFIED**：本仓库可读源码、已跑通的 `compose/intranet/verify.sh`（隔离 fresh-volume）、
  `docker compose config`、`bash -n`、`git diff --check`。
- **UNVERIFIED**：真实内网主机上的一次完整部署、浏览器端到端验证、备份/恢复真实演练、
  真实 provider（DeepSeek/Wiktionary）网络联通。
- **BLOCKED**：无——本文档不修改业务代码；真实部署所需密钥/证书/域名/Owner 信息见 §9。
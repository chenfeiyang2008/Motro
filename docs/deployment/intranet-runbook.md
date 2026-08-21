# Motro 内网部署 Runbook（Ticket 11）

> 执行对象：部署人员。逐节按序执行；任一步失败即停止，按 §4「迁移与失败处理」处置。
> 本文命令面向 `compose/intranet.yml` 内网栈；可执行验证脚本为 `compose/intranet/verify.sh`。
> 所有 `<请填>` 为占位符；真实值由 Owner 在 §9 提供，**不写入仓库**。

- 部署目标迁移版本：仓库 `db/migrations/` 目录当前最高为 **0045**（`0045_membership_daily_limit.sql`）。
  该值必须从源码动态确认（§4.1），不要写死。
- 前置：已按 [`intranet-deployment-checklist.md`](intranet-deployment-checklist.md) §1 完成部署前检查。

---

## 0. 拓扑速览

| 服务 | 端口（host 绑定） | 说明 | 数据 | 依赖 |
|---|---|---|---|---|
| `db` | 5432（默认回环） | PostgreSQL 16 | 命名卷 `db-data` | — |
| `worker-migrate` | 无 | 一次性：业务迁移 + Graphile schema | — | db healthy |
| `api` | 3000（默认回环） | Nest/Fastify | — | db healthy + worker-migrate 完成 |
| `worker` | 无 | 常驻消费者 + lease 恢复扫描 | — | db healthy + worker-migrate 完成 |
| `web` | 3001（默认回环） | Next.js | — | api started |
| `proxy`（Caddy） | 443/80（内网） | 浏览器唯一入口；TLS | — | web+api started |

就绪区分：`/api/v1/health/live`（进程存活）与 `/api/v1/health/ready`
（DB 可达 + `graphile_worker` schema 就绪）。worker 无 HTTP 端点，用进程存活 + 队列年龄探活。

---

## 1. 创建部署目录

```sh
# 部署目录建议独立于仓库：仓库内只放 compose 模板与构建上下文。
sudo mkdir -p /srv/motro /srv/motro-backups /srv/motro/config
# 进入仓库目录（构建镜像需要 db/migrations 上下文）：
cd /path/to/motro
```

---

## 2. 创建 intranet.env

```sh
# 从模板复制到仓库外（切勿把真实密钥提交进仓库）：
cp docs/deployment/intranet-env.example /srv/motro/intranet.env
chmod 600 /srv/motro/intranet.env
# 编辑并填写所有 <请填> 项，尤其是：
#   POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD
#   SESSION_KEY / CSRF_KEY（32+ 随机）
#   CORS_ORIGINS / WEB_PUBLIC_URL / API_PUBLIC_URL
#   INTRA_HOST_NAME / TLS_CERT_FILE / TLS_KEY_FILE
vi /srv/motro/intranet.env
```

> 生成随机密钥示例（部署机执行，结果粘贴进 intranet.env，不打印到日志/仓库）：
> `openssl rand -hex 32`
> 禁止在 `intranet.env` 中写入 `E2E_ADMIN_PASSWORD`（仅测试注入；见 §7.2）。

---

## 3. 校验 compose config

```sh
docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env config --quiet
```

- 失败 → 检查 `intranet.env` 是否缺 required 项（`${VAR:?}` 报错会列出变量名）。
- 成功后输出为空 / 退出码 0。

> 另可运行 `pnpm config:check`（仓库内）：校验 `SESSION_KEY`/`CSRF_KEY` 长度、
> production Secure cookie 等应用侧约束。

---

## 4. 启动 db

```sh
docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env up -d db
docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env ps db
# 等待 db 显示 healthy（`ps` 第二列健康状态；healthcheck 间隔 5s）
docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env ps db
```

`ps` 输出中 `db` 应为 `healthy`。若一直 `starting`，用 `logs db` 查看：
常见原因＝口令/库名不匹配、卷被旧版本占用、资源不足。

---

## 5. 执行 worker-migrate

```sh
# 一次性迁移（业务 migration 从 0001 顺序到当前最高 + Graphile official schema）。
docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env up --wait worker-migrate

# 观察日志确认无失败：
docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env logs worker-migrate
```

- 成功日志样例：`[worker:migrate] 业务 migration 已应用：N 个（总数含已存在）`
  `[worker:migrate] Graphile Worker schema 就绪（graphile_worker）`。
- 失败 → **停止，不得继续启动 api/worker**（`depends_on service_completed_successfully` 会拦住）。
  按 §6 处理。

---

## 6. 检查迁移 0001 → 当前最高版本

```sh
# 目标必须从源码动态确认（本例当前为 0045 → 45）：
ls db/migrations/ | sort -V | tail -1          # 期望 0045_*.sql

# 数据库侧确认最高已应用版本：
docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env exec -T db \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
  -tAc "SELECT max(version) FROM schema_migrations"
```

- 输出应为本地最大版本（45）。低于 → 有 pending/dispara，先跑 `worker-migrate`。
- 一致性复查（可选，仓库内直连）：
  ```sh
  POSTGRES_PASSWORD=... pnpm db:migrate:check
  ```
  期望输出 `OK：共 N 个 migration，状态一致`。
- **drift / extra** → 走 §12.3 hash drift 处理，不要手动改 `schema_migrations`。

---

## 7. 启动 api / worker / web

```sh
docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env up -d api worker web
docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env ps
```

- `api` / `worker` / `web` 均应 `Up`。
- 若 `api`/`worker` 未启动但 `worker-migrate` 成功 → 检查各自日志：
  `docker compose ... logs api` / `logs worker`（常见：配置校验报错、数据库口令、CORS 格式）。
- worker 无 HTTP 就绪端点：`ps` 存活 + `logs worker` 无循环错误即可。

---

## 8. 启动 Caddy（反向代理）

配置示例：`compose/intranet/proxy/Caddyfile`。

```sh
# 方式 A（推荐，独立服务）：在部署机用同一 Caddyfile 起容器，
# 挂载证书路径 `${TLS_CERT_FILE}` `${TLS_KEY_FILE}`，监听 `${PROXY_BIND_ADDR}:443`。
# 具体 compose 服务片段由部署者按本机环境补齐（示例文件不含真实路径）。
#
# 方式 B：若 Caddy 已在宿主运行，仅把 Caddyfile 路径、证书、反代地址指到本栈。
```

- 启动后验证：
  ```sh
  curl -f https://<WEB_PUBLIC_URL>/api/v1/health/live
  curl -f https://<WEB_PUBLIC_URL>/api/v1/health/ready
  ```
- 证书路径、`default_sni`、`auto_https off`、`request_body max_size 21MB`、安全头均已在此文件。

---

## 9. 检查 live / ready

```sh
API=http://127.0.0.1:3000/api/v1/health
curl -fsS "$API/live"
# => {"status":"ok","service":"motro-api","time":"..."}
curl -fsS "$API/ready"
# => {"status":"ok","service":"motro-api","time":"...","checks":{"db":"ok","graphileWorker":"ok"}}
```

- `ready` 返回 503 + `checks.graphileWorker=missing` → 业务迁移完成但 worker schema 未就绪，
  重跑 `worker-migrate`。
- 经 Caddy 再验一次（同路径，HTTPS）。

---

## 10. 浏览器访问首页和登录页

在部署机上：

```sh
curl -fsS -o /dev/null -w '%{http_code}\n' https://<WEB_PUBLIC_URL>/
# 期望 200
```

浏览器（学习者网卡内的任意机器）：

1. 打开 `https://<WEB_PUBLIC_URL>/` → 首页可渲染、无 5xx。
2. 点击登录 → `/login` 渲染登录表单。
3. 用引导管理员账号登录（见 §7.2）→ 进入学习端；退出回登录页。

失败排查：CORS/Cookie 配置（§3）、TLS 证书链、DNS 解析、`WEB_PUBLIC_URL` 与 `CORS_ORIGINS` 一致。

---

## 11. 引导首个管理员账号

生产环境**不写死**默认口令；用仓库内置引导 CLI 创建首管理员。该 CLI 从**环境变量**读取
`BOOTSTRAP_ADMIN_USERNAME`（默认 `admin`）与 `BOOTSTRAP_ADMIN_PASSWORD`（必填，≥12 字符），
以 argon2 存哈希；**不写入任何文件/日志**。`BOOTSTRAP_ADMIN_PASSWORD` 属一次性 secret，
用完即从 shell 历史清除。

```sh
# 仓库内，先构建 db CLI，再带 env 运行（env 不落盘）：
cd /path/to/motro
# CLI 只认 BOOTSTRAP_ADMIN_* 环境变量：
BOOTSTRAP_ADMIN_USERNAME=<owner-provided-username> \
BOOTSTRAP_ADMIN_PASSWORD='<owner-provided-strong-password>' \
pnpm db:bootstrap-admin
```

> 完成后把账号信息交给 Owner 记录（§16「首个管理员账号」）。`BOOTSTRAP_ADMIN_PASSWORD`
> 由 Owner 在私密渠道提供；CLI 不写入仓库/日志。`E2E_ADMIN_PASSWORD` 只用于自动化测试，
> **禁止**出现在 `/srv/motro/intranet.env`。

---

## 12. 迁移与失败处理

### 12.1 迁移失败

- `worker-migrate` 非零退出即停机点：api/worker 不启动。
- 查看日志定位失败 migration（`logs worker-migrate`）。
- 失败迁移在事务内回滚，schema 无部分状态；修复（通常是本地文件/口令/权限）后重跑 `up --wait worker-migrate`。
- **不跳过迁移**：不允许手动 `INSERT INTO schema_migrations` 制造"已应用"。

### 12.2 人工恢复（备份后）

- 停掉 api/worker（保持 db 不删）：
  ```sh
  docker compose -f compose/intranet.yml --env-file /srv/motro/intranet.env stop api worker
  ```
- 在**隔离空卷**执行恢复演练（见 [`backup-restore.md`](backup-restore.md) §5）：
  空卷建 schema（重新 `worker-migrate`）→ 导入最近已验证 dump → 对齐 schema 版本 → 验证健康。
- 确认可恢复后才回切；**绝不自动破坏性回滚**；未经 Owner 确认不删生产数据。

### 12.3 schema_migrations hash drift

- 症状：`pnpm db:migrate:check` 报 `drift`（已应用但哈希不一致）。
- 处理流程：
  1. 停 api/worker；
  2. `git -C <repo> status` 确认是谁改动了 `db/migrations/<N>_*.sql`；
  3. 若 N 是"已发布版本"，恢复为源头一致版本后再迁移；
  4. **不要** `UPDATE schema_migrations SET content_hash=...` 掩盖；
  5. 无法立即对齐 → 走备份恢复 §12.2。
- `extra`（库中有、本地无）：常见于多分支；确认后按备份/重建决策处理，不直接删记录。

---

## 13. 安全与加固速查

- 不暴露：PostgreSQL（5432 仅回环）、Graphile（internal）、worker 管理端口。
- Caddy 只监听内网网卡；`auto_https off` + 本地 CA 证书。
- 响应头：`nosniff`、`DENY` frame、`strict-origin-when-cross-origin` referrer、移除 `Server`。
- 请求体：`21MB`（对齐 multipart 20MB）。
- CORS：仅 `<WEB_PUBLIC_URL>` origin；Cookie `Secure` + `SameSite=Lax`。
- Provider（T22）：
  - **fake-only（默认）**：`MOTRO_PROVIDER_MODE=fake` → worker 注册 fake handler，零真实网络。
  - **real（仅 staging/production）**：`MOTRO_PROVIDER_MODE=real` → worker 注册真实 adapter。
    - production + real 未启用任一 provider → 启动失败（fail-fast）。
    - production + DeepSeek enabled 缺 `DEEPSEEK_API_KEY` → 启动失败（fail-fast）。
    - Wiktionary 仅允许 `MOTRO_WIKTIONARY_HOST_ALLOWLIST` 主机（SSRF）；HTTPS only。
    - 所有真实 provider 日志脱敏：不记录 API Key、Authorization header、完整 prompt/响应正文。

---

## 14. 上线验收清单

逐项勾选（可执行/可验证的在本 runbook 已覆盖；浏览器项需学习者网卡实测）：

| # | 验收项 | 命令 / 检查 | 过/否 |
|---|---|---|---|
| 1 | compose config | §3 `config --quiet` | ☐ |
| 2 | migration check | §6 `max(version)==45`；`db:migrate:check` 无 issue | ☐ |
| 3 | API live/ready | §9 live 200；ready 200 + checks 全 ok | ☐ |
| 4 | web 200 | §10 `curl -w %{http_code}` = 200 | ☐ |
| 5 | worker 存活 | `ps worker` Up；`logs worker` 无循环错 | ☐ |
| 6 | 登录/退出 | 浏览器引导 admin 登录→退出 | ☐ |
| 7 | 管理端首页 | `/admin` 渲染 | ☐ |
| 8 | 用户管理 | `/admin/users` 列表/建/改 | ☐ |
| 9 | 会员管理 | `/admin/memberships` 发放/续期/撤销 | ☐ |
| 10 | 课程列表分页 | `/admin/courses` 分页 | ☐ |
| 11 | 审核和发布 | 草稿审核→发布（fake provider） | ☐ |
| 12 | 激励文案 | `/admin/motivation` 编辑生效 | ☐ |
| 13 | 学习端课程 | `/courses` 列表、`/study` 学习 | ☐ |
| 14 | XP | 学习者 XP 累积展示 | ☐ |
| 15 | 排行榜 | `/leaderboard` 渲染 | ☐ |
| 16 | 挑战 | `/challenge` 答题、得分入账 | ☐ |
| 17 | 非会员剩余时长 | 按 `daily_budget_minutes` 显示 | ☐ |
| 18 | 备份任务 | 一次备份可 `pg_restore -l`；manifest 哈希匹配 | ☐ |
| 19 | 日志和磁盘监控 | 日志轮转；`df -h` 未越阈值 | ☐ |

> 自动化 smoke：`compose/intranet/verify.sh`（隔离 fresh-volume：config、live/ready、
> 迁移最高 ≥ 45、worker 存活、队列可写、web 可达）。部署机的真实浏览器 E2E 需另配
> `E2E_ADMIN_PASSWORD` + Playwright 环境，属**可选的只读验证**，不写进生产配置。

---

## 15. 上线后监控

运维实现：[../operations/monitoring.md](../operations/monitoring.md)。
盯：API 5xx、ready 失败（区分 DB / graphileWorker）、迁移失败、worker 队列堆积、
磁盘空间、PostgreSQL 连接数、日志轮转、备份失败、provider 网络开关状态。

---

## 16. Owner 待填写项（runbook 依赖）

| 项 | 填什么 | 用于 |
|---|---|---|
| 内网域名/IP | `<intranet-host>` | Caddy default_sni、CORS、WEB_PUBLIC_URL |
| TLS 证书路径 | cert/key 绝对路径 | Caddyfile |
| API/Web 端口 | host 绑定端口 | intranet.env `*_BIND_PORT` |
| PostgreSQL 数据目录 | `db-data` 卷路径 | 备份/恢复 |
| 备份目录 | `/srv/motro-backups` | backup-restore.md |
| 日志保留周期 | 天数 | logrotate |
| 是否允许外网访问 | 是/否 | 安全边界（本文默认否） |
| 是否启用真实 DeepSeek | 是/否 | `real` + `DEEPSEEK_ENABLED=true` + `DEEPSEEK_API_KEY`（secret 注入，不写仓库） |
| 是否启用真实 Wiktionary | 是/否 | `real` + `MOTRO_WIKTIONARY_ALLOW_NETWORK=true` + `MOTRO_WIKTIONARY_HOST_ALLOWLIST` |
| 首个管理员账号 | username | `db:bootstrap-admin` |
| 维护窗口和联系人 | 窗口/on-call | 备份、迁移、告警 |

---

## 交付状态

- **VERIFIED**：`docker compose config`、`verify.sh`（隔离 fresh-volume）、`bash -n verify.sh`、
  `git diff --check`、markdown 链接检查。
- **UNVERIFIED**：真实内网主机一次完整部署、真实浏览器端到端验收、备份/恢复真实演练、
  真实 provider 网络联通。
- **BLOCKED**：无。启动失败多为缺少 Owner 信息（§16）——尽快填写后再执行 §1–§10。
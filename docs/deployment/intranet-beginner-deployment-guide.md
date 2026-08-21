# Motro 内网正式上线：小白操作说明书

这份说明把 Motro 从一份代码部署成一套可在**公司/家庭内网**访问的学习系统。请按顺序做；任何一步报错，都先停在该步排查，**不要跳过迁移、不要删除数据库卷、不要手改 `schema_migrations` 表**。

适用范围：当前仓库的 Docker Compose 内网部署方案。它包含 PostgreSQL、API、Worker、Web；浏览器入口由 Caddy 反向代理提供 HTTPS。

> 先记住三件事：
>
> 1. 正式部署必须使用一个干净、可追溯的 Git 提交或标签，不能直接拿开发机的未提交工作目录上线。
> 2. 默认是安全的 fake provider 模式；先把系统部署跑通，再决定是否开启真实 Wiktionary / DeepSeek。
> 3. 备份放在与数据库**不同的磁盘或 NAS**，并且必须做一次恢复演练。

---

## 1. 上线前，你要准备什么

### 1.1 一台内网服务器

最低建议（小规模内网使用）：

| 项目 | 建议 |
|---|---|
| 系统 | Ubuntu 22.04/24.04 LTS 或其他受支持的 Linux 服务器 |
| CPU / 内存 | 4 核 / 8 GB 起步；多人导入、AI 草稿较多时使用 8 核 / 16 GB |
| 磁盘 | 系统与应用至少 50 GB；数据库和备份另预留空间 |
| 网络 | 固定私网 IP；学习者设备能访问该 IP 或内网域名 |
| 权限 | 可使用 `sudo` 的部署账号；不要用共享 root 账号日常操作 |

服务器上应安装并确认可用：

```sh
docker --version
docker compose version
git --version
openssl version
curl --version
```

Docker Compose 必须是 v2（命令形式为 `docker compose`，不是旧的 `docker-compose`）。

### 1.2 上线负责人需要事先给你的资料

先把下表填完。缺任何一项，不要开始正式上线。

| 需要的东西 | 示例 | 为什么需要 |
|---|---|---|
| 内网域名或固定 IP | `motro.intra.example` | 学习者访问系统、TLS 证书匹配 |
| DNS/hosts 配置权限 | 内网 DNS 指向服务器私网 IP | 让所有设备能找到 Motro |
| TLS 证书和私钥 | 公司 CA 或私有 CA 签发 | HTTPS 与安全 Cookie 必需 |
| 两个 32+ 字符随机密钥 | `SESSION_KEY`、`CSRF_KEY` | 登录会话与 CSRF 防护 |
| PostgreSQL 强口令 | 至少 20 字符 | 数据库账户保护 |
| 首个管理员用户名和密码 | 单独交付给负责人 | 创建管理员账号 |
| 备份位置与密钥 | NAS/第二块磁盘 + 加密密钥 | 发生故障时恢复数据 |
| 真实 AI 是否启用 | 是/否 | 决定是否需要 DeepSeek key 和外网白名单 |

> 不要把真实密码、API Key、证书私钥、备份解密密钥发在聊天群、写进 Git 仓库或截图里。

### 1.3 网络与端口规则

最终给学习者开放的只有 HTTPS 入口（通常是私网 `443`）。以下端口不得暴露给普通学习者网络：

| 端口 | 服务 | 正确状态 |
|---:|---|---|
| 5432 | PostgreSQL | 仅服务器回环或管理员受控网络 |
| 3000 | API | 仅服务器回环 / Docker 内网 |
| 3001 | Web | 仅服务器回环 / Docker 内网 |
| 443 | Caddy HTTPS | 仅内网网卡，允许学习者访问 |

如果要启动真实 provider，还需要网络管理员只放行：

- DeepSeek API 域名（按实际供应商文档与企业策略）；
- `en.wiktionary.org`；
- DNS、HTTPS 出站流量。

其他公网访问默认不放行。

---

## 2. 先审计“准备上线的代码包”

### 2.1 选择一个确定版本

不要部署开发机当前目录；该目录可能有别人的未提交改动。请选择经验证的提交或发布标签，例如 `<RELEASE_REF>`。

在一台干净的构建机或服务器上：

```sh
git clone <你的 Motro 仓库地址> /srv/motro/app
cd /srv/motro/app
git checkout <RELEASE_REF>
git status --porcelain
git rev-parse HEAD
```

验收标准：

- `git status --porcelain` **没有任何输出**；
- 记录 `git rev-parse HEAD` 的提交号到上线记录中；
- 所有迁移文件都在此提交内，不能依赖本地未跟踪的 `db/migrations/*.sql`。

### 2.2 在构建机做一次“放行检查”

在 `/srv/motro/app` 执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm format:check
pnpm openapi:check
pnpm db:migrate:check
pnpm test
git diff --check
```

所有命令都必须成功。任意一项失败，就不要制作上线包。

> `pnpm db:migrate:check` 需要连到一个受控的测试数据库；它不是让你修改生产数据库的命令。

### 2.3 制作可追溯上线包

推荐用 Git clone + 固定提交部署，而不是手工拖拽文件。若必须离线传输，在干净提交上生成压缩包，并连同提交号与 SHA-256 一起保存：

```sh
cd /srv/motro/app
git archive --format=tar.gz --prefix=motro/ -o /srv/motro/motro-<RELEASE_REF>.tar.gz HEAD
sha256sum /srv/motro/motro-<RELEASE_REF>.tar.gz > /srv/motro/motro-<RELEASE_REF>.tar.gz.sha256
```

不要把 `.env`、证书、真实 API Key 或备份文件打入该包。

---

## 3. 服务器首次准备

### 3.1 创建目录

```sh
sudo mkdir -p /srv/motro/app /srv/motro/config /srv/motro-backups
sudo chown -R "$USER":"$USER" /srv/motro
chmod 700 /srv/motro/config /srv/motro-backups
```

建议目录用途：

```text
/srv/motro/app/          # 固定提交的应用源码与 Compose 文件
/srv/motro/config/       # 真实环境变量、证书挂载说明（权限严格）
/srv/motro-backups/      # 备份暂存；推荐实际放到独立磁盘/NAS
```

### 3.2 创建生产环境文件

```sh
cd /srv/motro/app
cp docs/deployment/intranet-env.example /srv/motro/config/intranet.env
chmod 600 /srv/motro/config/intranet.env
nano /srv/motro/config/intranet.env
```

至少填写：

```dotenv
POSTGRES_DB=motro_intranet
POSTGRES_USER=motro
POSTGRES_PASSWORD=<20+字符强口令>

SESSION_KEY=<openssl rand -hex 32 的结果>
CSRF_KEY=<openssl rand -hex 32 的结果>
COOKIE_SECURE=true

INTRA_HOST_NAME=motro.intra.example
WEB_PUBLIC_URL=https://motro.intra.example
API_PUBLIC_URL=https://motro.intra.example/api/v1
CORS_ORIGINS=https://motro.intra.example

TLS_CERT_FILE=<证书在服务器上的绝对路径>
TLS_KEY_FILE=<私钥在服务器上的绝对路径>
BACKUP_DIR=/srv/motro-backups
```

生成密钥：

```sh
openssl rand -hex 32
```

先保持以下安全默认值：

```dotenv
MOTRO_PROVIDER_MODE=fake
DEEPSEEK_ENABLED=false
MOTRO_WIKTIONARY_ALLOW_NETWORK=false
```

> 不要执行 `source /srv/motro/config/intranet.env`。环境文件中有可能含空格或括号，不能保证是安全的 shell 脚本。只把它交给 `docker compose --env-file`。

### 3.3 检查 Compose 配置能否展开

```sh
cd /srv/motro/app
docker compose -f compose/intranet.yml \
  --env-file /srv/motro/config/intranet.env config --quiet
```

没有输出且退出成功，才可以继续。若报 `${变量名:?}`，回到环境文件补齐那个变量。

---

## 4. 重要审计结论：Caddy 不是自动启动的

当前 `compose/intranet.yml` 启动 `db`、`worker-migrate`、`api`、`worker`、`web`，**没有定义 `proxy` 服务**。仓库仅提供了 Caddy 配置样例：[Caddyfile](../../compose/intranet/proxy/Caddyfile)。

因此，以下事项是正式上线前的必做项：

1. 由运维把 Caddy 加入与 Motro 相同的 Docker 网络，或配置宿主机 Caddy；
2. 将 TLS 证书、私钥以只读方式交给 Caddy；
3. Caddy 只绑定服务器私网 IP，不绑定公网 `0.0.0.0`；
4. 确认 Caddy 可以访问 API 和 Web。

两种可选方案：

| 方案 | 适用情况 | Caddy 上游地址 |
|---|---|---|
| 同一个 Compose 项目里的 Caddy 服务（推荐） | 新部署、最不容易网络配置错误 | `api:3000`、`web:3001` |
| 宿主机已有 Caddy | 公司已有统一反向代理 | `127.0.0.1:3000`、`127.0.0.1:3001` |

不要把 Caddy 独立放在另一个 Docker 网络后还使用 `api:3000` / `web:3001`；它通常解析不到这些 Docker 服务名。

把 `PROXY_BIND_ADDR` 从模板中的 `127.0.0.1` 改成服务器的**私网 IP**，例如 `10.20.30.40`，并由防火墙限制只允许内网网段访问 443。

---

## 5. 第一次启动（严格按顺序）

统一定义命令，后续直接复制：

```sh
cd /srv/motro/app
export COMPOSE="docker compose -f compose/intranet.yml --env-file /srv/motro/config/intranet.env"
```

### 5.1 构建镜像并启动数据库

```sh
$COMPOSE build
$COMPOSE up -d db
$COMPOSE ps db
```

等到 `db` 状态显示为 `healthy`。若不是，先看：

```sh
$COMPOSE logs --tail=100 db
```

### 5.2 运行迁移（最关键的一步）

```sh
$COMPOSE up --wait worker-migrate
$COMPOSE logs --tail=200 worker-migrate
```

成功后才允许启动 API 和 Worker。迁移失败时：

- 不启动 API/Worker；
- 不手动往 `schema_migrations` 插入或删除记录；
- 不修改已发布 migration 文件；
- 保留日志，修复原因后重新运行本步骤。

### 5.3 动态核对迁移版本

不要把“45”写死；每次发版都从源码读取最高 migration：

```sh
EXPECTED_MIGRATION="$({ find db/migrations -maxdepth 1 -type f -name '*.sql' -print | sort -V | tail -n 1; } \
  | sed -E 's#.*/0*([0-9]+)_.*#\1#')"
APPLIED_MIGRATION="$($COMPOSE exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT COALESCE(max(version), 0) FROM schema_migrations"')"
printf '源码最高迁移：%s；数据库已应用：%s\n' "$EXPECTED_MIGRATION" "$APPLIED_MIGRATION"
```

两个数字必须相同。当前代码库此刻最高文件是 `0045_membership_daily_limit.sql`，但未来发版应以命令输出为准。

### 5.4 启动应用服务

```sh
$COMPOSE up -d api worker web
$COMPOSE ps
$COMPOSE logs --tail=100 api
$COMPOSE logs --tail=100 worker
```

预期：`api`、`worker`、`web` 是 `Up`；`worker-migrate` 成功退出（这是正常的一次性服务）。

### 5.5 启动并验证 HTTPS 代理

在 Caddy 已按第 4 节配置并启动后，先从服务器验证内部 API：

```sh
curl -fsS http://127.0.0.1:3000/api/v1/health/live
curl -fsS http://127.0.0.1:3000/api/v1/health/ready
```

再从一台学习者内网电脑验证 HTTPS（请使用公司/私有 CA 已信任的证书）：

```sh
curl -fsS https://motro.intra.example/api/v1/health/live
curl -fsS https://motro.intra.example/api/v1/health/ready
```

`ready` 必须返回 `checks.db=ok` 与 `checks.graphileWorker=ok`。不要用 `curl -k` 把证书错误当作验收通过。

---

## 6. 创建首个管理员并做最小验收

系统没有生产默认管理员密码。使用内置 CLI 创建第一个管理员。

这条 CLI 从环境读取数据库连接配置与：

- `BOOTSTRAP_ADMIN_USERNAME`（管理员用户名）；
- `BOOTSTRAP_ADMIN_PASSWORD`（至少 12 字符）。

请在一个**已安全注入生产数据库环境变量**的 shell 内执行；不要把密码写入脚本或仓库：

```sh
cd /srv/motro/app
BOOTSTRAP_ADMIN_USERNAME='<管理员用户名>' \
BOOTSTRAP_ADMIN_PASSWORD='<一次性强密码>' \
pnpm db:bootstrap-admin
```

随后用浏览器完成这组最小验收：

1. 打开 `https://<你的内网域名>/`，首页返回 200；
2. 打开 `/login`，能看到登录表单；
3. 用首个管理员登录；
4. 打开管理端，确认能访问课程、用户、会员、审核等页面；
5. 新建一个普通学习者，确认其无法访问管理端；
6. 管理员与学习者分别退出登录，确认会回到登录页；
7. 在另一台内网电脑重复登录测试。

完成后立刻把初始密码交给负责人保管，并按组织政策改成个人管理员账号；不要共享一个长期管理员密码。

---

## 7. 启用真实 Wiktionary / DeepSeek（可选，第二阶段）

先以 fake 模式稳定运行并完成第 6 节验收。再由负责人批准开启真实 provider。

在 `/srv/motro/config/intranet.env` 中改为：

```dotenv
MOTRO_PROVIDER_MODE=real
DEEPSEEK_ENABLED=true
MOTRO_WIKTIONARY_ALLOW_NETWORK=true
DEEPSEEK_API_KEY=<从秘密管理系统注入的真实密钥>
MOTRO_WIKTIONARY_HOST_ALLOWLIST=en.wiktionary.org
```

然后仅重建受影响服务：

```sh
cd /srv/motro/app
$COMPOSE up -d --build api worker
$COMPOSE logs --tail=100 api worker
```

上线负责人要确认：

- DeepSeek key 不在 Git、不在截图、不在日志；
- 防火墙只允许所需域名与 HTTPS；
- 用一个**非敏感测试词**做一次真实来源/草稿 smoke；
- 监控超时、响应体过大、白名单拒绝与 provider 错误；
- 无法连通时，恢复到 fake 模式并重启 `api`、`worker`。

真实 provider 是额外的网络依赖。它不能连通不应影响已经上线的登录、课程、学习、XP 等本地功能，但相关导入/富集任务会失败并进入运维队列。

---

## 8. 每日备份与每月恢复演练

完整规范见 [备份与恢复说明](backup-restore.md)。最低要求：

1. 每天生成 PostgreSQL `pg_dump --format=custom`；
2. 备份原始导入文件和 SHA-256 清单；
3. 加密备份；
4. 备份保留在不同于服务器数据库卷的磁盘/NAS；
5. 保留至少 30 个恢复点；
6. 每月在隔离环境做一次恢复，并记录是否能登录、读取课程、查看迁移版本。

备份完成后至少检查：

```sh
pg_restore --list /path/to/motro-YYYY-MM-DD.dump > /dev/null
```

只看到备份文件存在不算成功；必须证明它能恢复。

---

## 9. 日常更新流程

每次升级都按下面的“小版本发布”做：

1. 在测试环境完成所有门禁与浏览器验收；
2. 记录新发布提交号与 migration 最高版本；
3. 在生产先完成一次已验证备份；
4. 在维护窗口停止 `api` 与 `worker`，保留 `db`；
5. 切换到经过审计的发布提交；
6. 重新 `build`；
7. 运行 `worker-migrate`，动态核对版本；
8. 启动 `api worker web`；
9. 做 live/ready、登录、管理员和学习者冒烟验证；
10. 记录操作人、时间、提交号、迁移版本和结果。

示例：

```sh
cd /srv/motro/app
$COMPOSE stop api worker
git fetch --tags
git checkout <新的已批准发布标签>
$COMPOSE build
$COMPOSE up --wait worker-migrate
$COMPOSE up -d api worker web
$COMPOSE ps
```

### 禁止的“快捷修复”

- `docker compose down -v`（会删除数据库卷）；
- `git reset --hard`（可能丢失尚未保护的内容）；
- 手工修改 `schema_migrations`；
- 直接改已经生产应用过的 migration；
- 为了通过检查而关闭安全校验、TLS 或 CSRF。

发生迁移 drift、数据库异常、恢复不确定时：停止 `api`/`worker`，保留数据库与日志，先咨询负责工程师，再按恢复手册处理。

---

## 10. 常见问题速查

| 现象 | 先做什么 |
|---|---|
| Compose 提示变量未设置 | 检查 `/srv/motro/config/intranet.env`，不要把真实值写入仓库 |
| `worker-migrate` 失败 | 看 `logs worker-migrate`；不要启动 API/Worker，不要手改 migration 记录 |
| `ready` 失败但 `live` 正常 | 查看 DB 连接和 `graphile_worker`；重新检查迁移日志 |
| 浏览器打不开但本机 curl 正常 | 检查 DNS、内网防火墙、Caddy 是否运行、证书是否受信任 |
| 登录后不断跳回登录页 | 检查 `WEB_PUBLIC_URL`、`CORS_ORIGINS`、`COOKIE_SECURE=true` 与 HTTPS 域名一致 |
| 真实 AI 任务失败 | 先看 worker 日志与防火墙/DNS；必要时切回 fake mode |
| 备份文件无法 `pg_restore --list` | 该备份不可用；立刻保留并使用上一个已验证恢复点 |

---

## 11. 上线完成确认单

只有全部勾选，才算“可正式交给内网用户”：

- [ ] 使用干净、记录了提交号的发布版本。
- [ ] 所有构建/类型/测试/格式/OpenAPI/迁移检查通过。
- [ ] 环境文件权限为 `600`，其中没有测试密码。
- [ ] PostgreSQL、API、Web 未对普通内网开放端口。
- [ ] Caddy 已实际运行，绑定私网 IP，HTTPS 证书被学习者设备信任。
- [ ] `live` 与 `ready` 均返回成功，且 ready 含 DB 与 Worker schema 正常。
- [ ] 源码最高 migration 与生产数据库最高 migration 相同。
- [ ] 首个管理员与普通学习者的登录/权限/退出验证完成。
- [ ] 完成首份备份，且至少一次恢复演练成功。
- [ ] 若启用真实 provider，密钥、出站白名单与真实 smoke 已由负责人验收。
- [ ] 已记录：部署时间、操作人、发布提交、迁移版本、备份位置和回退负责人。

---

## 12. 当前项目的上线边界（审计结论）

当前代码和已有预发布演练已经验证了：Docker Compose 隔离构建、迁移链、API/Worker/Web 启动、健康检查、fake provider、备份与恢复流程。

但下面几项必须由真实内网环境的负责人完成，不能用开发机结果替代：

1. 内网 DNS/hosts 与实际学习者设备访问；
2. Caddy 服务落地和真实 TLS 证书加载；
3. 生产密钥与首个管理员的安全交接；
4. 真实 DeepSeek/Wiktionary 的密钥、网络白名单和一次真实 smoke（若启用）；
5. 备份磁盘/NAS 与月度恢复演练制度。

这些完成后，Motro 才是“正式内网全功能上线”，而不只是本机开发环境可运行。

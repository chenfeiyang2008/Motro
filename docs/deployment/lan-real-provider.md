# Motro 家庭局域网部署 runbook（真实 Provider + 自签 TLS）

> 适用场景：**仅局域网可达**（服务器在 NAT/路由器后，公网不可达）的家庭 Ubuntu 服务器，
> 浏览器通过 `https://<LAN_IP>:8443` 访问，且**开启真实外部 Provider**
> （DeepSeek 释义 + Wiktionary 词源）。
>
> 本文与仓库现有的 `intranet-runbook.md`（Tailscale/内网域名视角）互补：那里用私有 CA 域名，
> 这里用**局域网 IP + openssl 自签证书**，无需域名、无需公网。
>
> **本文不含任何真实密钥、证书、IP、口令。** 所有 `<...>` 占位符由你在部署机上替换。
> 真实 `intranet.env` 必须放在仓库外（如 `/srv/motro/`，`chmod 600`），绝不提交。

---

## 为什么是 production + Caddy 自签，而不是 development

Motro 的 `packages/config/src/config.ts` 有一条 cross-field 校验链：

- `NODE_ENV=production` 时强制 `COOKIE_SECURE=true`（否则启动 fail-fast）。
- 开启真实 Provider 时（`MOTRO_PROVIDER_MODE=real` + DeepSeek），production 校验会
  强制 `DEEPSEEK_API_KEY` 非空并真正生效；dev 模式会跳过这套校验、key 是否被应用不可靠。
- 纯 HTTP 下浏览器拒绝保存 `Secure` Cookie → 登录失效。

因此三条约束交集下，正确形态是 **production + HTTPS**。Caddy 用内网自签证书终结 TLS，
浏览器走 `https://<LAN_IP>:8443`，Secure Cookie 合法，real provider 校验也满足。
首次访问会有自签证书警告（浏览器点"高级 → 继续访问"即可），局域网内可接受。

---

## 服务拓扑

| 服务 | 容器端口 | 主机绑定 | 说明 |
| --- | --- | --- | --- |
| `db` | 5432 | `127.0.0.1:5432` | PostgreSQL 16，卷 `db-data` |
| `worker-migrate` | — | — | 一次性：业务迁移 + Graphile schema |
| `migrate` | — | — | 一次性：应用 SQL 迁移 |
| `api` | 3000 | `127.0.0.1:3000` | Nest/Fastify，仅容器网内可达 |
| `worker` | — | 无 | 常驻消费者，无暴露端口 |
| `web` | 3001 | `127.0.0.1:3001` | Next.js，仅经 Caddy 暴露 |
| `proxy` | 443(in) | `0.0.0.0:8443` | Caddy 自签 TLS，浏览器唯一入口 |

浏览器只访问 `proxy:8443`；`web` 用同源 `/api/*` 反代到 `api`，故无需直连 `api`。

---

## 0. 前置（部署机上）

```sh
# 架构/资源
uname -m                       # 期望 x86_64；架构不符需改镜像标签
free -h                        # 期望 ≥4GB；不足请加 swap（见下）
df -h /var/lib/docker          # 持久存储需有空间（镜像 + 卷）

# Docker Engine + Compose v2
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
docker compose version         # 需 v2.x

# openssl（生成自签证书用，Ubuntu 自带）
openssl version
```

**4GB 内存防 OOM（构建期）**：构建镜像时 `pnpm build` 可能吃光内存。

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

构建时限制 Node 堆：

```sh
export NODE_OPTIONS=--max-old-space-size=2048
```

---

## 1. 把代码弄到服务器

```sh
# 方式 A：git clone（推荐，便于升级）
git clone <你的仓库地址> /srv/motro/app
cd /srv/motro/app

# 方式 B：从本机 rsync 整个 motro 仓库（保持 .git 与 lockfile 一致）
# rsync -a --exclude node_modules --exclude .next --exclude dist \
#   /Volumes/.../project/motro/ user@<LAN_IP>:/srv/motro/app/
```

> 必须带 `pnpm-lock.yaml` 与 `.npmrc`（已指向 npmmirror 镜像），否则 `--frozen-lockfile` 构建失败。

---

## 2. 生成自签证书（带 IP SAN）

Caddy 的 `proxy.yaml` 把证书以只读卷挂进容器，路径须与 `proxy/Caddyfile` 中的
`${TLS_CERT_FILE}`/`${TLS_KEY_FILE}` 一致。用 `<LAN_IP>` 作 Subject Alternative Name。

```sh
mkdir -p /srv/motro/tls && cd /srv/motro/tls
openssl req -x509 -newkey rsa:2048 -nodes -keyout motro.key -out motro.crt \
  -days 825 \
  -subj "/CN=<LAN_IP>" \
  -addext "subjectAltName=IP:<LAN_IP>"
chmod 600 motro.key motro.crt          # 私钥仅 owner 可读
ls -l                                   # 确认 motro.crt / motro.key 存在
```

记下绝对路径（后面填进 env）：
- 证书：`/srv/motro/tls/motro.crt`
- 私钥：`/srv/motro/tls/motro.key`

> 证书有效期 825 天（≈2.25 年，避开 398 天上限且足够久）。到期前重新生成并 `docker compose restart proxy`。

---

## 3. 写 intranet.env（production + real provider）

```sh
mkdir -p /srv/motro
cat > /srv/motro/intranet.env <<'EOF'
NODE_ENV=production

# ---- PostgreSQL ----
POSTGRES_DB=motro
POSTGRES_USER=motro
POSTGRES_PASSWORD=<强随机口令，openssl rand -base64 24>
POSTGRES_BIND_ADDR=127.0.0.1
POSTGRES_BIND_PORT=5432

# ---- Cookie / CSRF（必填 32+ 随机）----
SESSION_KEY=<openssl rand -hex 32 的输出>
CSRF_KEY=<openssl rand -hex 32 的输出>
COOKIE_SECURE=true
COOKIE_SAMESITE=lax

# ---- API / Web（浏览器走 Caddy HTTPS）----
API_BIND_ADDR=127.0.0.1
API_BIND_PORT=3000
WEB_BIND_ADDR=127.0.0.1
WEB_BIND_PORT=3001
CORS_ORIGINS=https://<LAN_IP>:8443
WEB_PUBLIC_URL=https://<LAN_IP>:8443
API_PUBLIC_URL=https://<LAN_IP>:8443/api/v1
API_INTERNAL_URL=http://api:3000

# ---- Worker ----
WORKER_CONCURRENCY=1
WORKER_MAX_POOL_SIZE=2
WORKER_MAX_ATTEMPTS=5
WORKER_POLL_INTERVAL_MS=2000
WORKER_LEASE_MS=60000
WORKER_RECOVER_INTERVAL_MS=2000
WORKER_RECOVER_BATCH_SIZE=20

# ---- 真实 Provider（两者都开）----
MOTRO_PROVIDER_MODE=real
DEEPSEEK_ENABLED=true
DEEPSEEK_API_KEY=<你的 DeepSeek API Key>
DEEPSEEK_API_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=30000
DEEPSEEK_MAX_RESPONSE_BYTES=1048576
MOTRO_WIKTIONARY_ALLOW_NETWORK=true
WIKTIONARY_API_BASE_URL=https://en.wiktionary.org/w/api.php
MOTRO_WIKTIONARY_USER_AGENT=MotroBot/1.0 (contact: 1284146898@qq.com)
MOTRO_WIKTIONARY_TIMEOUT_MS=15000
MOTRO_WIKTIONARY_MAX_RESPONSE_BYTES=5242880
MOTRO_WIKTIONARY_HOST_ALLOWLIST=en.wiktionary.org

# ---- 日志 / OpenAPI / 限速 ----
LOG_LEVEL=info
OPENAPI_ENABLED=false
RATE_LIMIT_LOGIN_PER_MINUTE=10

# ---- Caddy 自签 TLS（proxy.yaml / Caddyfile 占位符）----
INTRA_HOST_NAME=<LAN_IP>
TLS_CERT_FILE=/srv/motro/tls/motro.crt
TLS_KEY_FILE=/srv/motro/tls/motro.key
PROXY_BIND_ADDR=0.0.0.0
PROXY_BIND_PORT=8443
EOF
chmod 600 /srv/motro/intranet.env
```

占位符替换清单（务必全部替换，否则 `--env-file` fail-fast 拒绝启动）：
- `<LAN_IP>`：服务器局域网 IP，如 `192.168.1.20`
- `<强随机口令…>`：用 `openssl rand -base64 24` 生成
- `<openssl rand -hex 32 的输出>`：SESSION_KEY / CSRF_KEY 各生成一个
- `<你的 DeepSeek API Key>`：DeepSeek 平台申请的 key（real 模式生产校验必填）

---

## 4. 校验配置

```sh
cd /srv/motro/app
F="--env-file /srv/motro/intranet.env"
docker compose -f compose/intranet.yml -f compose/intranet/proxy.yaml $F config --quiet \
  && echo "compose config OK"
```

任何 `${VAR:?}` 缺失或格式错误都会在此步报错并打印缺失项。

---

## 5. 构建 + 起库 + 跑迁移

> 构建可能耗时数分钟（多阶段镜像，pnpm build 全 workspace）。保持第 0 步的
> `NODE_OPTIONS=--max-old-space-size=2048` 环境仍在。

```sh
# 构建镜像并起 PostgreSQL
docker compose -f compose/intranet.yml -f compose/intranet/proxy.yaml $F up -d --build db

# 业务迁移 + Graphile schema（一次性）
docker compose -f compose/intranet.yml $F up -d --build worker-migrate
docker compose -f compose/intranet.yml $F logs worker-migrate      # 确认 exit 0、无报错

# 应用 SQL 迁移（一次性）
docker compose -f compose/intranet.yml $F up -d --build migrate
docker compose -f compose/intranet.yml $F logs migrate             # 确认迁移到最新版本
```

迁移任一失败 → 非零退出，`api`/`worker` 因 `depends_on: service_completed_successfully`
不会启动（fail-fast，不自动回滚）。

---

## 6. 起应用 + 反代

```sh
docker compose -f compose/intranet.yml -f compose/intranet/proxy.yaml $F up -d api worker web proxy
```

`proxy` 依赖 `web` + `api` 已起；Caddy 监听 `0.0.0.0:8443`，证书从宿主机只读挂载。

---

## 7. 创建首个管理员

用现成的 api 镜像跑一次性容器（无需在服务器装 Node）：

```sh
docker compose -f compose/intranet.yml $F run --rm \
  -e BOOTSTRAP_ADMIN_PASSWORD='<你的管理员强口令，≥12字符>' \
  api node packages/db/dist/cli-bootstrap-admin.js
```

默认用户名 `admin`。口令仅在运行时传入、不落盘、不进日志。

---

## 8. 健康检查

```sh
curl -f http://127.0.0.1:3000/api/v1/health/live
curl -f http://127.0.0.1:3000/api/v1/health/ready
# 期望 {"status":"ok","checks":{"db":"ok","graphileWorker":"ok"}}

# 可选：跑仓库自带 smoke（fresh-volume 隔离，不改本机库）
# ENV_FILE=/srv/motro/intranet.env bash compose/intranet/verify.sh
```

---

## 9. 浏览器访问

打开 `https://<LAN_IP>:8443`。

- 首次访问出现**自签证书警告** → 浏览器点「高级 / Advanced」→「继续访问 / Proceed」。
- 用 `admin` + 第 7 步设的口令登录。
- 真实 Provider 已生效：新建词条/导入后，worker 会真实调用 DeepSeek 与 Wiktionary。

---

## 运维

### 升级（拉新代码后）
```sh
cd /srv/motro/app && git pull
F="--env-file /srv/motro/intranet.env"
docker compose -f compose/intranet.yml -f compose/intranet/proxy.yaml $F up -d --build
# 迁移幂等：已应用的迁移有内容哈希保护，重复运行安全
```

### 查看日志
```sh
docker compose -f compose/intranet.yml -f compose/intranet/proxy.yaml $F logs -f api
docker compose -f compose/intranet.yml -f compose/intranet/proxy.yaml $F logs -f proxy
```

### 停止（保留数据卷）
```sh
docker compose -f compose/intranet.yml -f compose/intranet/proxy.yaml $F down
# 彻底销毁（不可恢复，仅确认清库）：末尾加 -v
```

### 备份
见 `docs/deployment/backup-restore.md`。重点备份：`db-data` 卷 + `/srv/motro/intranet.env`
（密钥）+ `/srv/motro/tls/`（证书）。备份卷与解密密钥**不得同卷存放**。

### 证书续期（≈2.25 年后）
重新执行第 2 步生成新证书（同名覆盖），然后：
```sh
docker compose -f compose/intranet.yml -f compose/intranet/proxy.yaml $F restart proxy
```

---

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `config --quiet` 报 `${VAR:?}` 缺失 | 第 3 步某占位符未替换；按提示补 |
| `ConfigError: production 必须使用 Secure cookie` | `COOKIE_SECURE` 非 `true` |
| `ConfigError: production 启用 DeepSeek 时必须提供 DEEPSEEK_API_KEY` | real 模式下 DEEPSEEK_API_KEY 为空 |
| 浏览器登录后会话丢失 | 未走 HTTPS（CORS_ORIGINS/WEB_PUBLIC_URL 应全 `https://<LAN_IP>:8443`） |
| Caddy 起不来 / 证书错误 | `TLS_CERT_FILE`/`TLS_KEY_FILE` 路径不存在或权限问题；确认第 2 步生成成功且路径一致 |
| 构建 OOM killed | 第 0 步 swap + `NODE_OPTIONS` 未生效 |
| 迁移失败卡住、api 不启动 | 看 `logs worker-migrate` / `logs migrate`，按 `backup-restore.md` 处理，勿 `down -v` |
| worker 真实调用超时 | 确认服务器能出网；Wiktionary 域名在 `MOTRO_WIKTIONARY_HOST_ALLOWLIST` |

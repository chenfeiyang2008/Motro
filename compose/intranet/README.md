# Motro 内网部署模板（Ticket 11）——部署 runbook

本目录把 research-only 的部署规格落实为**可执行的内网部署基础**。只做内网/私有；
**不做公网上线**；默认假 Provider（fake/fixture），**不访问真实 Wiktionary/DeepSeek**。

> 本目录不包含真实密钥、域名、证书、服务器地址。所有值均为 `${PLACEHOLDER}`；
> 真值由部署者在部署机上提供，且不写入仓库。

## 服务拓扑（核对）

| 服务             | 端口               | 说明                               | 数据             | 依赖                             |
| ---------------- | ------------------ | ---------------------------------- | ---------------- | -------------------------------- |
| `db`             | 5432（仅内网绑定） | PostgreSQL 16                      | 命名卷 `db-data` | —                                |
| `worker-migrate` | —                  | 一次性：业务迁移 + Graphile schema | —                | db healthy                       |
| `api`            | 3000（仅内网绑定） | Nest/Fastify                       | —                | db healthy + worker-migrate 完成 |
| `worker`         | —                  | 常驻消费者 + 恢复扫描，不暴露端口  | —                | db healthy + worker-migrate 完成 |
| `web`            | 3001（仅内网绑定） | Next.js                            | —                | api started                      |
| `proxy`（可选）  | 443/80（内网）     | Caddy TLS，浏览器唯一入口          | —                | web+api started                  |

**就绪区分**：`GET /api/v1/health/live`（进程存活）与 `GET /api/v1/health/ready`
（区分 DB 可达 vs `graphile_worker` schema 就绪）。worker 暂无 HTTP 就绪端点
（见置顶清单），用进程存活 + 队列年龄探活。

## 前置与校验（部署机上）

```sh
# 架构/资源/时间同步前置检查
uname -a
free -h
df -h /var/lib/docker   # 确保持久存储有足够空间
timedatectl             # 或 chrony/ntp 状态

# 从仓库构建；本部署脚本不推送镜像。
# 镜像/commit：在部署机上从受信私有源拉取或本地构建。
```

## 环境变量占位符（intranet.env 示例，勿提交真实值）

`compose/intranet.yml` 引用以下变量；部署机用 `--env-file intranet.env` 提供，或导入 shell。
**空值/缺省会 fail-fast 拒绝启动**（`${VAR:?}` 语义）。

```
POSTGRES_DB=<请填>
POSTGRES_USER=<请填>
POSTGRES_PASSWORD=<请填，强口令>
POSTGRES_BIND_ADDR=127.0.0.1        # 或内网私有网卡
POSTGRES_BIND_PORT=5432

SESSION_KEY=<请填 32+ 随机>
CSRF_KEY=<请填 32+ 随机>
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
CORS_ORIGINS=http://<intranet-host>  # 学习端浏览器可见 origin

API_BIND_ADDR=127.0.0.1
API_BIND_PORT=3000
WEB_BIND_ADDR=127.0.0.1
WEB_BIND_PORT=3001
WEB_PUBLIC_URL=http://<intranet-host>   # 浏览器访问 origin

# Provider（T22：三档部署模式）
#   1) fake-only 内网演示（默认）：MOTRO_PROVIDER_MODE=fake，零真实网络；
#   2) real provider staging：MOTRO_PROVIDER_MODE=real + 测试 key / allowlist；
#   3) real provider production：MOTRO_PROVIDER_MODE=real + 真实 key（配置不写入仓库）。
DEEPSEEK_ENABLED=false
MOTRO_WIKTIONARY_ALLOW_NETWORK=false
MOTRO_PROVIDER_MODE=fake

# 真实 provider 参数（仅 real 模式需要；fake-only 可留空）
DEEPSEEK_API_KEY=
DEEPSEEK_API_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=30000
DEEPSEEK_MAX_RESPONSE_BYTES=1048576
WIKTIONARY_API_BASE_URL=https://en.wiktionary.org/w/api.php
MOTRO_WIKTIONARY_USER_AGENT=MotroBot/1.0 (contact: motro@example.com)
MOTRO_WIKTIONARY_TIMEOUT_MS=15000
MOTRO_WIKTIONARY_MAX_RESPONSE_BYTES=5242880
MOTRO_WIKTIONARY_HOST_ALLOWLIST=en.wiktionary.org

# Worker
WORKER_CONCURRENCY=1
WORKER_MAX_POOL_SIZE=2
WORKER_MAX_ATTEMPTS=5
WORKER_POLL_INTERVAL_MS=2000
WORKER_LEASE_MS=60000
WORKER_RECOVER_INTERVAL_MS=2000
WORKER_RECOVER_BATCH_SIZE=20
```

## 启停 / 迁移 / 健康

```sh
# 1) 迁移前先确保只有 worker-migrate 一次性跑迁移（不允许多实例各跑迁移）
docker compose -f compose/intranet.yml --env-file intranet.env up -d --build db worker-migrate
docker compose -f compose/intranet.yml --env-file intranet.env logs worker-migrate

# 2) 启动应用与 worker
docker compose -f compose/intranet.yml --env-file intranet.env up -d api worker web

# 3) readiness（区分 DB / Graphile）
curl -f http://127.0.0.1:3000/api/v1/health/live
curl -f http://127.0.0.1:3000/api/v1/health/ready   # 期望 {"status":"ok","checks":{"db":"ok","graphileWorker":"ok"}}

# 停止（保留数据卷）
docker compose -f compose/intranet.yml --env-file intranet.env down
# 彻底销毁（不可恢复；仅确认清库时）
docker compose -f compose/intranet.yml --env-file intranet.env down -v
```

## 迁移失败行为

- `worker-migrate` 任一业务迁移失败 → 非零退出；`api`/`worker` 因 `depends_on
condition: service_completed_successfully` 不会启动。
- 已应用的迁移有内容哈希校验；失败不回滚旧迁移、不自动破坏性回滚。
- 恢复按 `docs/deployment/backup-restore.md` 的 runbook 选择，**不自动 destructive rollback**。

## 反向代理 / TLS

示例见 `compose/intranet/proxy/Caddyfile`。要点：只监听内网地址；`auto_https off` +
`tls{cert_file,key_file}`（私有 CA/自签）；请求体 `21MB`；安全响应头；健康检查路径
`/api/v1/health/*` 与业务路由分区。浏览器只访问 proxy；postgres/worker 无对外端口。

## 备份 / 恢复 / 监控

- 备份与恢复 runbook：`docs/deployment/backup-restore.md`
- 运维与监控清单：`docs/operations/monitoring.md`
- 全部路径 / 周期为占位符，部署者替换，且不操作真实备份目录。

## 验证

`compose/intranet/verify.sh` 提供 fresh-volume 最小 smoke：迁移到当前版本、API readiness、
worker 启停、fake-only 演示探活。运行方式与前提见脚本头与 Ticket 11 报告。

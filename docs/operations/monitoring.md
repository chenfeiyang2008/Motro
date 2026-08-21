# Motro 内网运维与监控清单（Ticket 11）

仅面向内网；所有主机名/路径/周期/端口为**占位符**。每条命令注明：执行环境、是否改数据、
风险、回滚方式。**不建立 Prometheus/Grafana 集群**；用轻量、可审计的命令与日志完成。

## 0. 状态速查

| 探针 | 命令/端点 | 改数据 | 风险 | 回滚 |
|---|---|---|---|---|
| API 存活 | `GET 127.0.0.1:3000/api/v1/health/live` | 否 | 低 | — |
| API 就绪（DB+Graphile） | `GET /api/v1/health/ready` | 否 | 低 | — |
| DB 可达 | `pg_isready` / `SELECT 1` | 否 | 低 | — |
| 迁移状态 | `curl ready` 的 `graphileWorker` + `schema_migrations` 查询 | 否 | 低 | — |
| Worker 存活 | `docker ... ps` / `logs` 存活 | 否 | 低 | — |
| 队列积压 | worker 日志 / DB 查询 `graphile_worker.jobs` 计数 | 只读 SQL | 低 | — |

## 1. 磁盘 / 内存

```sh
# 环境：部署主机。改数据：否。风险：低。回滚：—。
df -h /var/lib/docker        # 关注 /var/lib/docker 与备份卷
free -h
# 告警建议：磁盘使用 >80%，或 /var/lib/docker 剩余 <2GB；内存 swap >0 且持续
```

## 2. PostgreSQL 连接 / 迁移状态

```sh
# 只读 SQL（进入 db 容器）
docker compose -f compose/intranet.yml exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT version, name FROM schema_migrations ORDER BY version;"
# 当前迁移最高版本必须动态等于源码 db/migrations/ 目录最高版本（勿依赖固定值）。
# 对比：ls db/migrations/ | sort -V | tail -1
# 连接数：
docker compose ... exec db psql -c "SELECT count(*) FROM pg_stat_activity;"
# 告警建议：连接数接近 max_connections 的 80%；迁移版本与预期不一致
```

## 3. Worker 健康与队列积压

```sh
# Worker 无 HTTP 端点：用进程存活 + 日志。
docker compose -f compose/intranet.yml ps worker
docker compose -f compose/intranet.yml logs --tail=100 worker

# 队列积压（只读）：
docker compose ... exec db psql -c \
  "SELECT count(*) FROM graphile_worker.jobs WHERE locked_by IS NULL AND run_at <= now();"
# 告警建议：积压持续增长或单任务 age 超阈值；worker 重启频率异常
```

## 4. 日志轮转

```sh
# 日志尽量走容器 stdout（json）→ 由 Docker/系统 journal 或 logrotate 收集。
# 占位配置：/etc/logrotate.d/motro（示例，需部署者按宿主日志路径落地）
#   /var/log/motro/*.log {
#     daily size 100M rotate 14 compress delaycompress missingok notifempty
#     copytruncate
#   }
# 改数据：否（仅日志文件）。风险：低。回滚：移除此文件。
```

## 5. 失败告警建议

- API ready 持续 `degraded`（`graphileWorker=missing`）→ Graphile schema 缺失，先跑 worker-migrate。
- Worker 停止 / 积压增长 → 恢复 `worker` 服务（`docker compose up -d worker`）。
- 最新已验证备份 > 36h → 触发备份（`docs/deployment/backup-restore.md`）。
- 供应商失败（未来启用真实 provider 时）→ pause/retry 队列；学习中与已发布内容不受影响。
- 磁盘 / 内存越阈值 → 扩容或清理旧 image / 备份。

## 6. 风险边界

- 所有只读查询不改数据；**拒绝**直接 `UPDATE/DELETE` schema_migrations 或 graphile_worker 表。
- 不清理 / 重建共享库；不暴露 postgres/graphile/worker 管理端口。
- 本清单不引入新端口 / 新依赖；可执行验证用 `compose/intranet/verify.sh`（隔离 fresh volume）。
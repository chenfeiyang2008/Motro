# Motro 备份与恢复 Runbook（Ticket 11）

仅面向内网部署；所有路径 / 凭据 / 周期为**占位符**。本 runbook 不操作真实备份目录。

> 原则：**备份成功 ≠ 退出码 0**，而是「可恢复的产物」。恢复演练需在隔离空环境做，成功后
> 记录时长与证据。**绝不自动破坏性回滚**。

## 1. 备份内容清单

| 项 | 来源 | 说明 |
|---|---|---|
| PostgreSQL 逻辑 dump | `db` 服务命名卷 `db-data` | 与运行主版本兼容的逻辑 dump（非文件级拷贝） |
| 配置文件 | `intranet.env` / compose 模板 / Caddyfile | 重建服务所需、不含真实密钥泄露的受控文件（密钥引占位符） |
| 原始导入文件 | `IMPORT_FILE_ROOT_DIR`（默认 `.local-import-files`） | 内容文件 + SHA-256 manifest |
| 生成报告（可选） | 部署者指定目录 | 视需要纳入 |

**不备份**：可重建的缓存（如 web `.next`、Graphile state 表、临时文件）。

## 2. 目录占位符

```
BACKUP_DIR=/srv/motro-backups          # 独立磁盘/NAS；不得与 DB 数据同卷
BACKUP_STAGING=/srv/motro-backups/staging
BACKUP_RETENTION_DAYS=30
BACKUP_ENC_KEY_FILE=/root/motro-backup.key   # 解密密钥绝不与备份并存
```

## 3. 执行备份（每日，一致性 checkpoint 后）

```sh
# 0) 先做一致性 checkpoint，再 dump（避免 dump 期间跨不一致状态）
docker compose -f compose/intranet.yml --env-file intranet.env exec db \
  pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --format=custom \
  -f /tmp/motro.dump
# 注意：pg_dump 在容器内执行，产物先落到容器临时目录再拷出（见下）

# 1) 备份 DB dump
docker compose ... exec -T db pg_dump ... > "${BACKUP_STAGING}/motro-$(date +%F).dump"

# 2) 备份配置与内容文件 + SHA-256 manifest
(cd /srv/motro && tar -czf "${BACKUP_STAGING}/motro-config.tgz" compose/intranet.yml compose/intranet.env.placeholder docs/deployment)
find "${IMPORT_FILE_ROOT_DIR:-.local-import-files}" -type f -print0 | xargs -0 sha256sum > "${BACKUP_STAGING}/manifest.sha256"
tar -czf "${BACKUP_STAGING}/motro-files.tgz" -C "${IMPORT_FILE_ROOT_DIR:-.local-import-files}" . .manifest 2>/dev/null || true

# 3) 加密后拷到独立磁盘（openssl 示例；真实实现用部署者选定的加密工具）
openssl enc -aes-256-cbc -salt -pbkdf2 -in "${BACKUP_STAGING}/motro-$(date +%F).dump" \
  -out "${BACKUP_DIR}/motro-$(date +%F).dump.enc" -pass file:"${BACKUP_ENC_KEY_FILE}"

# 4) 保留 30 个恢复点；删除过期（示例：find -mtime +${RETENTION} -delete）
find "${BACKUP_DIR}" -type f -mtime "+${BACKUP_RETENTION_DAYS}" -delete
```

> 以上命令的容器交互、`exec`/`exec -T`、以及把凭据传给 `docker exec` 的方式都需按部署机加固；
> 本文为 runbook 占位，**不执行**，真实备份由部署者按加固文件落地。

## 4. 备份校验与告警

- 备份后立即做一次 dump 完整性检查：`pg_restore --list <dump>` 或 `pg_restore -l`。
- 告警阈值：`最新已验证备份年龄 > 36 小时` → 告警。验证「可恢复」，而非只看文件存在。
- 月付一次（见 §5）恢复演练验证整体可恢复。

## 5. 恢复演练（隔离空环境）

```sh
# 1) 空库准备（全新命名卷；不接触现网）
docker compose -f compose/intranet.yml --env-file intranet.verify.env down -v     # 仅隔离卷
docker compose -f compose/intranet.yml --env-file intranet.verify.env up -d db

# 2) 恢复 dump（先跑迁移以对齐 schema，再导入）
docker compose ... exec -T db pg_restore -U ... -d ... < motro-<date>.dump.enc（解后）
#   若选 空库回归：先 migration 0001→当前，再导入数据。

# 3) 验证：schema version 匹配、文件 manifest 各哈希匹配、登录、课程读取、
#    一笔非生产 study 事务成功；记录时长与证据。
```

**回滚**：恢复不成功 → 保持现网隔离不开放；回到上一个已验证备份，或暂停服务诊断。
绝不自动破坏性回滚。

## 6. 风险与边界

- `down -v` 只作用于隔离 `motro-intranet` 卷，不影响共享 `motro` / `motro-e2e-import`。
- 不把解密密钥与备份放同盘；不把密钥写入仓库。
- 本 runbook 未申请/未配置真实密钥；所有加密实现由部署决策补齐。
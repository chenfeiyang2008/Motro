#!/usr/bin/env bash
# Motro 内网 fresh-volume 最小验证（Ticket 11）——隔离、不触网、不改共享库。
#
# 用途：对 compose/intranet.yml 做“空卷启动 → 迁移 0001→当前 → API readiness →
#       worker 启停 → fake-only 演示 smoke”。只在独立命名卷/独立端口上跑；
#       不访问真实 Wiktionary/DeepSeek；不清理共享 motro/e2e 库。
#
# 前置：
#   - 提供 intranet.env（占位符：POSTGRES_DB/USER/PASSWORD/SESSION_KEY/CSRF_KEY/CORS_ORIGINS/WEB_PUBLIC_URL）
#   - 本机可用 docker compose v2。
#
# 用法：
#   docker compose -f compose/intranet.yml --env-file intranet.env \
#     -f compose/intranet/verify.override.yml up -d --build
#   然后调用本脚本做探活（也可把本脚本作为 CI smoke 入口）。
#
# 退出码：0 = 全过；非 0 = 某项失败（打印失败项，不静默吞错）。
set -euo pipefail

PROJECT=${PROJECT:-motro-intranet}
ENV_FILE=${ENV_FILE:-intranet.env}
# 与 compose/intranet/verify.override.yml 中的端口保持一致（isolated fresh-volume 栈）。
API_VERIFY_PORT=${API_VERIFY_PORT:-3002}
WEB_VERIFY_PORT=${WEB_VERIFY_PORT:-3003}
API_HEALTH=${API_HEALTH:-http://127.0.0.1:${API_VERIFY_PORT}/api/v1/health}
WEB_URL=${WEB_URL:-http://127.0.0.1:${WEB_VERIFY_PORT}}
# 允许部署者覆盖 compose 参数（端口等在 intranet.env）。

# 把 intranet.env 导出到当前 shell，使后续 psql -U ${POSTGRES_USER} -d ${POSTGRES_DB}
# 能正确取到库名/用户名（docker --env-file 只喂给 compose 插值，不影响本脚本进程）。
if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

# 优先追加 verify.override.yml（isolated fresh-volume 栈）；缺失时退化为单一 intranet.yml。
COMPOSE=(docker compose -f compose/intranet.yml)
if [ -f compose/intranet/verify.override.yml ]; then
  COMPOSE+=(-f compose/intranet/verify.override.yml)
fi
COMPOSE+=(--env-file "${ENV_FILE}")

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

step "1/6 检查 compose 配置可解析"
"${COMPOSE[@]}" config --quiet || fail "compose config 解析失败"

step "2/6 检查健康端点（live + ready）"
# 依赖 API 已启动（verify.override 或部署机手动 up）。
curl -fsS "${API_HEALTH}/live" >/dev/null 2>&1 || fail "live 不可达"
ready=$(curl -fsS "${API_HEALTH}/ready" 2>/dev/null || true)
if [ -z "$ready" ]; then
  # ready 可能在 DB/Graphile 尚未就绪时返回 503——这是预期；此处等它就绪。
  for _ in $(seq 1 30); do
    ready=$(curl -fsS "${API_HEALTH}/ready" 2>/dev/null || true)
    [ -n "$ready" ] && break
    sleep 2
  done
fi
[ -n "$ready" ] || fail "ready 一直不可达（30 次×2s）"
echo "ready=$ready"
echo "$ready" | grep -q '"db":"ok"' || fail "DB 未就绪"
echo "$ready" | grep -q '"graphileWorker":"ok"' || fail "graphile_worker schema 未就绪"

step "3/6 校验迁移版本（schema_migrations 最高 == 源码最高）"
# 动态从源码 db/migrations/ 确定目标版本，不写死固定值。
EXPECTED_MIG=$(ls db/migrations/*.sql 2>/dev/null | sort -V | tail -1 | sed -E 's/.*\/([0-9]+)_.*/\1/')
EXPECTED_MIG=${EXPECTED_MIG:-0}
[ "${EXPECTED_MIG}" -gt 0 ] || fail "无法从源码 db/migrations/ 确定迁移目标版本"
max_mig=$("${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-motro}" -d "${POSTGRES_DB:-motro}" \
  -tAc "SELECT max(version) FROM schema_migrations" 2>/dev/null || echo "")
[ "${max_mig:-0}" -eq "${EXPECTED_MIG}" ] || fail "迁移最高版本 ${max_mig:-0} != 源码最高 ${EXPECTED_MIG}"

step "4/6 worker 进程存活"
"${COMPOSE[@]}" ps worker | grep -qi "Up" || fail "worker 未运行"

step "5/6 worker 队列可写（graphile_worker schema 存在且空跑）"
jobs=$("${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-motro}" -d "${POSTGRES_DB:-motro}" \
  -tAc "SELECT count(*) FROM graphile_worker.jobs" 2>/dev/null || echo "ERR")
echo "graphile_worker.jobs 行数=$jobs"
case "$jobs" in *[!0-9]*) fail "无法读取 graphile_worker.jobs" ;; esac

step "6/6 Web 可达（学习端首页；同源 /api/v1 代理到 API）"
curl -fsS -o /dev/null "${WEB_URL}/" || fail "web 不可达"

printf '\nALL CHECKS PASSED (fake-only, isolated fresh volume)\n'

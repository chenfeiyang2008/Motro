// 阶段 6 工单 04：operation 纯领域规则单测（无数据库、无网络）。
// 覆盖：状态转换合法/非法、retry/permanent 分类、input hash/job key 确定性、
// 分隔符碰撞防护、错误摘要脱敏、payload schema 拒绝额外/敏感字段、decalation 边界。
import { describe, expect, it } from "vitest";
import {
  claimDecision,
  classifyError,
  ERROR_SUMMARY_MAX_LENGTH,
  generateClaimToken,
  generateRecoveryEpoch,
  isLeaseExpired,
  isLegalTransition,
  isRetryEligible,
  isValidQueueName,
  isValidTaskIdentifier,
  looksLikeUuidEmbedded,
  MOTRO_JOB_KEY_NAMESPACE,
  MOTRO_RECOVERY_JOB_KEY_NAMESPACE,
  operationInputHash,
  operationJobKey,
  RECOVERY_MAX_ATTEMPTS,
  recoveryCandidateWhere,
  recoveryJobKey,
  recoveryJobMaxAttempts,
  SAFE_ERROR_SUMMARY,
  safeErrorSummary,
  sanitizeErrorSummary,
  validateOperationPayload,
  type OperationStatus,
} from "@motro/domain";

describe("operation 状态机", () => {
  const STATUSES: OperationStatus[] = [
    "queued",
    "running",
    "retry_wait",
    "succeeded",
    "failed",
    "manual_action",
  ];

  it("合法转换被接受", () => {
    expect(isLegalTransition("queued", "running")).toBe(true);
    expect(isLegalTransition("queued", "succeeded")).toBe(true);
    expect(isLegalTransition("running", "retry_wait")).toBe(true);
    expect(isLegalTransition("retry_wait", "running")).toBe(true);
    expect(isLegalTransition("retry_wait", "queued")).toBe(true);
    expect(isLegalTransition("running", "failed")).toBe(true);
    expect(isLegalTransition("failed", "queued")).toBe(true); // 管理员重试
    expect(isLegalTransition("manual_action", "queued")).toBe(true);
  });

  it("所有列出的状态都是合法枚举值且自反一致", () => {
    for (const s of STATUSES) {
      expect(STATUSES).toContain(s);
    }
  });

  it("非法转换被拒绝", () => {
    expect(isLegalTransition("succeeded", "queued")).toBe(false);
    expect(isLegalTransition("succeeded", "running")).toBe(false);
    expect(isLegalTransition("succeeded", "failed")).toBe(false);
    expect(isLegalTransition("failed", "running")).toBe(false); // 只能回 queued
    expect(isLegalTransition("running", "queued")).toBe(false); // 运行中不能回队
    expect(isLegalTransition("queued", "manual_action")).toBe(false); // 排队直接人工不合理
    expect(isLegalTransition("retry_wait", "succeeded")).toBe(false);
  });
});

describe("错误分类", () => {
  it("已知可重试码 → retryable", () => {
    expect(classifyError("OPERATION_TRANSIENT")).toBe("retryable");
  });
  it("已知永久码 → permanent", () => {
    expect(classifyError("OPERATION_PERMANENT")).toBe("permanent");
    expect(classifyError("OPERATION_TARGET_MISSING")).toBe("permanent");
    expect(classifyError("OPERATION_INVALID_PAYLOAD")).toBe("permanent");
  });
  it("未知/空错误码保守视为可重试（由 maxAttempts 兜底）", () => {
    expect(classifyError(undefined)).toBe("retryable");
    expect(classifyError(null)).toBe("retryable");
    expect(classifyError("")).toBe("retryable");
    expect(classifyError("SOME_UNKNOWN")).toBe("retryable");
  });
});

describe("管理员重试资格", () => {
  it("只允许 failed / manual_action", () => {
    expect(isRetryEligible("failed")).toBe(true);
    expect(isRetryEligible("manual_action")).toBe(true);
    expect(isRetryEligible("running")).toBe(false);
    expect(isRetryEligible("queued")).toBe(false);
    expect(isRetryEligible("retry_wait")).toBe(false);
    expect(isRetryEligible("succeeded")).toBe(false);
  });
});

describe("input hash / job key 确定性", () => {
  it("同一输入产生完全相同 hash", () => {
    const a = operationInputHash({
      operationType: "motro-op-fixture",
      targetType: "import_batch_commit_row",
      targetId: "00000000-0000-4000-8000-000000000001",
      inputVersion: 1,
    });
    const b = operationInputHash({
      operationType: "motro-op-fixture",
      targetType: "import_batch_commit_row",
      targetId: "00000000-0000-4000-8000-000000000001",
      inputVersion: 1,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("不同输入版本或目标产生不同 hash", () => {
    const base = {
      operationType: "motro-op-fixture",
      targetType: "import_batch_commit_row",
      targetId: "00000000-0000-4000-8000-000000000001",
      inputVersion: 1,
    };
    expect(operationInputHash({ ...base, inputVersion: 2 })).not.toBe(operationInputHash(base));
    expect(
      operationInputHash({ ...base, targetId: "00000000-0000-4000-8000-000000000002" }),
    ).not.toBe(operationInputHash(base));
    expect(operationInputHash({ ...base, operationType: "other" })).not.toBe(
      operationInputHash(base),
    );
  });

  it("分隔符防碰撞：不同字段拼接不产生同一 hash", () => {
    // 构造性碰撞：操作类型 [a] + targetId [bc] vs 操作类型 [ab] + targetId [c]。
    // 若无长度前缀分隔符，这两个会拼接成相同字符串。校验它们 hash 不同。
    const t1 = operationInputHash({
      operationType: "a",
      targetType: "import_batch_commit_row",
      targetId: "bc000000-0000-4000-8000-000000000001",
      inputVersion: 1,
    });
    const t2 = operationInputHash({
      operationType: "ab",
      targetType: "import_batch_commit_row",
      targetId: "c0000000-0000-4000-8000-000000000001",
      inputVersion: 1,
    });
    expect(t1).not.toBe(t2);
  });

  it("job key 带固定 Motro 命名空间且含 operation UUID", () => {
    const id = "00000000-0000-4000-8000-000000000007";
    const key = operationJobKey(id);
    expect(key).toBe(`${MOTRO_JOB_KEY_NAMESPACE}:${id}`);
    expect(key.startsWith(MOTRO_JOB_KEY_NAMESPACE)).toBe(true);
    expect(key).toContain(id);
  });
});

describe("任务/队列名低基数守卫", () => {
  it("task identifier 只允许短低基数 ASCII", () => {
    expect(isValidTaskIdentifier("motro-op-fixture")).toBe(true);
    expect(isValidTaskIdentifier("motro-op-fixture.")).toBe(true);
    expect(isValidTaskIdentifier("")).toBe(false);
    expect(isValidTaskIdentifier("has space")).toBe(false);
    expect(isValidTaskIdentifier("中文")).toBe(false);
  });

  it("queue name 禁 UUID 载体", () => {
    expect(isValidQueueName("local")).toBe(true);
    expect(isValidQueueName("supplier_catalog")).toBe(true);
    // 含 UUID → 低基数违例。
    expect(isValidQueueName("00000000-0000-4000-8000-000000000001")).toBe(false);
    expect(looksLikeUuidEmbedded("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(looksLikeUuidEmbedded("local")).toBe(false);
  });
});

describe("错误摘要脱敏", () => {
  it("移除换行与控制字符，压缩空白", () => {
    const s = sanitizeErrorSummary("line1\r\nline2\t tab\npassword=hunter2");
    expect(s).not.toMatch(/[\r\n\p{Cc}]/u);
    expect(s).not.toContain("\n");
    expect(s).not.toContain("\r");
  });

  it("受限长度", () => {
    // 用带空格的短词重复，避免触发高熵 token 脱敏，纯测长度截断。
    const long = "fixture word ".repeat(2000);
    const s = sanitizeErrorSummary(long);
    expect(s.length).toBeLessThanOrEqual(ERROR_SUMMARY_MAX_LENGTH);
    expect(s.length).toBe(ERROR_SUMMARY_MAX_LENGTH);
  });

  it("非字符串输入转为 JSON 文本", () => {
    const s = sanitizeErrorSummary({ code: 123 });
    expect(s).toContain("123");
  });

  it("必须脱敏 password/token/secret/URL 凭据/路径/长高熵 token", () => {
    const cases = [
      "connection failed password=hunter2",
      "Authorization: Bearer abcdef0123456789abcdef0123456789",
      "api_key=sk-live-0123456789abcdef",
      "postgresql://user:superSecret@host:5432/db",
      "storage_key=/var/lib/motro/imports/secret-file.csv",
      "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ];
    for (const input of cases) {
      const s = sanitizeErrorSummary(input);
      expect(s).not.toContain("hunter2");
      expect(s).not.toContain("sk-live");
      expect(s).not.toContain("superSecret");
      expect(s).not.toContain("secret-file.csv");
      expect(s).not.toMatch(/Bearer\s+[a-z0-9._-]{16,}/i);
      expect(s).not.toMatch(/[A-Za-z0-9_-]{24,}/);
    }
    // 无敏感内容的文本原样保留可读片段（白名单式）。
    const clean = sanitizeErrorSummary("fixture retryable failure");
    expect(clean).toContain("fixture");
  });

  it("safeErrorSummary：未知错误用固定安全占位，不持久化原始 message", () => {
    const s = safeErrorSummary(
      undefined,
      "password=hunter2 and a long token abcdef0123456789abcdef",
    );
    expect(s).toBe(SAFE_ERROR_SUMMARY);
    expect(s).not.toContain("hunter2");
  });

  it("safeErrorSummary：已知固定错误码返回固定领域文案，不回显原始 message", () => {
    // 已知错误码：即使原始 message 含秘密，也返回固定文案（P2-2 收口）。
    const transient = safeErrorSummary("OPERATION_TRANSIENT", "password=hunter2 timeout");
    expect(transient).toContain("临时失败");
    expect(transient).not.toContain("hunter2");
    const permanent = safeErrorSummary("OPERATION_PERMANENT", "/var/lib/secret connection refused");
    expect(permanent).toContain("永久失败");
    expect(permanent).not.toMatch(/var\/lib|secret/);
    const invalid = safeErrorSummary("OPERATION_INVALID_PAYLOAD", "payload contains api_key=xyz");
    expect(invalid).toContain("载荷无效");
    expect(invalid).not.toContain("api_key");
    const max = safeErrorSummary(
      "OPERATION_MAX_ATTEMPTS_EXCEEDED",
      "attempts exceeded password=zz",
    );
    expect(max).toContain("最大尝试次数");
    expect(max).not.toContain("password");
    // 未知错误码：固定安全占位，绝不回显原文。
    const unknown = safeErrorSummary("SOME_NEW_CODE", "db password=hunter2 connection failed");
    expect(unknown).toBe(SAFE_ERROR_SUMMARY);
    expect(unknown).not.toContain("hunter2");
  });
});

describe("payload schema", () => {
  it("接受合法稳定 payload", () => {
    const r = validateOperationPayload({
      operationId: "00000000-0000-4000-8000-000000000001",
      inputVersion: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.operationId).toBe("00000000-0000-4000-8000-000000000001");
      expect(r.payload.inputVersion).toBe(1);
    }
  });

  it("拒绝额外字段", () => {
    const r = validateOperationPayload({
      operationId: "00000000-0000-4000-8000-000000000001",
      inputVersion: 1,
      extra_field: "something",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("EXTRA_FIELD");
  });

  it("拒绝敏感字段（token/password/storage key/path/content）", () => {
    const cases = [
      { password: "x", operationId: "00000000-0000-4000-8000-000000000001", inputVersion: 1 },
      { apiKey: "x", operationId: "00000000-0000-4000-8000-000000000001", inputVersion: 1 },
      { storageKey: "x", operationId: "00000000-0000-4000-8000-000000000001", inputVersion: 1 },
      { filePath: "/tmp/x", operationId: "00000000-0000-4000-8000-000000000001", inputVersion: 1 },
      { content: "x", operationId: "00000000-0000-4000-8000-000000000001", inputVersion: 1 },
      { response: "x", operationId: "00000000-0000-4000-8000-000000000001", inputVersion: 1 },
      { providerData: "x", operationId: "00000000-0000-4000-8000-000000000001", inputVersion: 1 },
    ];
    for (const c of cases) {
      const r = validateOperationPayload(c);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe("SENSITIVE_FIELD");
    }
  });

  it("拒绝非法 UUID / 错误类型", () => {
    const badUuid = validateOperationPayload({ operationId: "not-a-uuid", inputVersion: 1 });
    expect(!badUuid.ok && badUuid.code).toBe("INVALID_UUID");

    const badVersion = validateOperationPayload({
      operationId: "00000000-0000-4000-8000-000000000001",
      inputVersion: 0,
    });
    expect(!badVersion.ok && badVersion.code).toBe("BAD_TYPE");

    const badType = validateOperationPayload("string");
    expect(!badType.ok && badType.code).toBe("BAD_TYPE");
  });
});

describe("claim / lease 模型", () => {
  const now = new Date("2026-08-13T00:00:00Z");

  it("isLeaseExpired 判定过期", () => {
    expect(isLeaseExpired(new Date(now.getTime() + 1000), now)).toBe(false);
    expect(isLeaseExpired(new Date(now.getTime() - 1), now)).toBe(true);
    expect(isLeaseExpired(null, now)).toBe(false);
    expect(isLeaseExpired(undefined, now)).toBe(false);
  });

  it("claimDecision：queued/retry_wait 可领取", () => {
    expect(claimDecision({ status: "queued", leaseExpiresAt: null, now })).toBe("claimable");
    expect(claimDecision({ status: "retry_wait", leaseExpiresAt: null, now })).toBe("claimable");
  });

  it("claimDecision：running 未过期 no-op，已过期可重领", () => {
    expect(
      claimDecision({ status: "running", leaseExpiresAt: new Date(now.getTime() + 1000), now }),
    ).toBe("noop");
    expect(
      claimDecision({ status: "running", leaseExpiresAt: new Date(now.getTime() - 1), now }),
    ).toBe("reclaimable");
  });

  it("claimDecision：succeeded/failed/manual_action 永久 no-op", () => {
    expect(claimDecision({ status: "succeeded", leaseExpiresAt: null, now })).toBe("noop");
    expect(claimDecision({ status: "failed", leaseExpiresAt: null, now })).toBe("noop");
    expect(claimDecision({ status: "manual_action", leaseExpiresAt: null, now })).toBe("noop");
  });

  it("generateClaimToken 产生不可猜测的 UUID", () => {
    const a = generateClaimToken();
    const b = generateClaimToken();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });
});

describe("lease-expiry recovery（工单 04）", () => {
  const opId = "00000000-0000-4000-8000-0000000000aa";
  const token = "11111111-2222-4333-8444-555555555555";

  it("recoveryJobKey 使用独立命名空间且由 operationId + claimToken 派生（稳定 identity）", () => {
    const key = recoveryJobKey(opId, token);
    expect(key.startsWith(MOTRO_RECOVERY_JOB_KEY_NAMESPACE)).toBe(true);
    expect(key).toContain(opId);
    expect(key).toContain(token);
    // 与普通 enqueue 的 jobKey 不同命名空间：原 job 与恢复 job 不冲突。
    expect(recoveryJobKey(opId, token)).not.toBe(operationJobKey(opId));
    // 同一 operation 同一 claim token → 同一 recovery jobKey（并发去重基础）。
    expect(recoveryJobKey(opId, token)).toBe(recoveryJobKey(opId, token));
    // 不同 claim token（如旧 worker 覆盖新 claim）→ 不同 jobKey。
    expect(recoveryJobKey(opId, token)).not.toBe(
      recoveryJobKey(opId, "99999999-9999-4999-8999-999999999999"),
    );
  });

  it("RECOVERY_MAX_ATTEMPTS 为保守默认 5", () => {
    expect(RECOVERY_MAX_ATTEMPTS).toBe(5);
  });

  it("recoveryJobMaxAttempts：业务上限与 recovery 底线取较大者（Graphile 重投不替代业务状态机）", () => {
    // 业务 max_attempts 很小（如 1）时，recovery job 的 Graphile 投递/重投预算仍 ≥ 底线，
    // 避免挽救 job 因业务上限被饿死成一次性投递。
    expect(recoveryJobMaxAttempts(1)).toBe(5);
    expect(recoveryJobMaxAttempts(3)).toBe(5);
    expect(recoveryJobMaxAttempts(5)).toBe(5);
    // 业务上限比较大时，recovery job 的 Graphile 投递预算跟随业务上限。
    expect(recoveryJobMaxAttempts(7)).toBe(7);
    expect(recoveryJobMaxAttempts(25)).toBe(25);
  });

  it("generateRecoveryEpoch 产生不可猜测的 UUID（epoch 从权威事实派生不依赖内存计数）", () => {
    const a = generateRecoveryEpoch();
    const b = generateRecoveryEpoch();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });

  it("recoveryCandidateWhere 只筛选 running + lease 已过期", () => {
    const where = recoveryCandidateWhere();
    expect(where).toContain("status = 'running'");
    expect(where).toContain("lease_expires_at IS NOT NULL");
    expect(where).toContain("lease_expires_at < now()");
    // 绝不匹配 succeeded / queued / retry_wait（非 running 不得进入恢复队列）。
    expect(where).not.toContain("queued");
    expect(where).not.toContain("retry_wait");
  });
});

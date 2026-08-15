// 阶段 6 工单 04：Worker 操作的纯领域规则。
//
// 本文件只含无副作用、可确定性单测的纯规则：
//   - application operation 状态机与合法/非法状态转换；
//   - retryable / permanent 错误分类；
//   - 管理员重试资格判定；
//   - input hash 与 job key 的确定性推导（含分隔符碰撞防护）；
//   - task payload 的稳定 schema 校验（只允许不透明 ID 与版本）。
//
// 真实数据库事务、Graphile add_job、claim/lease 与持久化放在 API/Worker 层。
// 本模块不 import Nest、pg、Graphile 或网络库。
import { createHash } from "node:crypto";

// ---- 状态机 ----

export const OPERATION_STATUSES = [
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "failed",
  "manual_action",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/**
 * operation 最终态：不再由 worker 自动推进，也无法被普通 worker 流程改写。
 * 管理员重试只允许针对 `failed` / `manual_action`（见 isRetryEligible）。
 */
export const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set([
  "succeeded",
  "failed",
  "manual_action",
]);

/** 合法状态转换表。key 为当前状态，值为可合法转换到的目标状态集合。 */
const TRANSITIONS: Record<OperationStatus, ReadonlySet<OperationStatus>> = {
  queued: new Set(["running", "succeeded", "failed"]),
  running: new Set(["running", "retry_wait", "succeeded", "failed", "manual_action"]),
  retry_wait: new Set(["running", "queued"]),
  succeeded: new Set([]),
  failed: new Set(["queued"]), // 仅由管理员重试触发的合法离开路径。
  manual_action: new Set(["queued"]), // 仅由管理员重试触发的合法离开路径。
};

/**
 * 判定一次状态转换是否合法。用于领域层拒绝非法写入（数据库 CHECK 是最终防线，
 * 但此纯函数可被单元测试与 handler 提前校验）。
 */
export function isLegalTransition(from: OperationStatus, to: OperationStatus): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

// ---- 错误分类 ----

/** 可重试错误：Worker 会自动退避重试，直至最大尝试次数。 */
export const RETRYABLE_ERROR_CODES = new Set([
  "OPERATION_TRANSIENT",
  // 工单 05 seam 修复（Ticket 04→05）：WIKI transient 契约。真实 provider 仍未实现；
  // 此分类只建立稳定错误契约，供未来 adapter 复用，不新增任何 provider 逻辑或网络请求。
  "WIKI_TRANSIENT",
  // 工单 06 seam（Ticket 06）：DRAFT 瞬态契约。网络/限流/5xx 可自动重试；
  // 空输出/非 JSON 至多重试 1 次（由 maxAttempts 兜底，耗尽转 failed→manual）。
  "DRAFT_NETWORK_ERROR",
  "DRAFT_TIMEOUT",
  "DRAFT_RATE_LIMIT",
  "DRAFT_SERVER_ERROR",
  "DRAFT_EMPTY_OUTPUT",
  "DRAFT_INVALID_JSON",
]);

/** 永久错误：任何重试都不会改变结果，operation 直接 failed。 */
export const PERMANENT_ERROR_CODES = new Set([
  "OPERATION_PERMANENT",
  "OPERATION_TARGET_MISSING",
  "OPERATION_INVALID_PAYLOAD",
  "OPERATION_ALREADY_SUCCEEDED",
  "OPERATION_MAX_ATTEMPTS_EXCEEDED",
  // 工单 05 seam 修复（Ticket 04→05）：WIKI permanent 契约。见 P1-2。
  "WIKI_RESPONSE_MALFORMED",
  "WIKI_RESPONSE_TOO_LARGE",
  "WIKI_UNSAFE_CONTENT",
  "WIKI_PROVIDER_CONTRACT",
  // 工单 06 seam（Ticket 06）：DRAFT permanent 契约。重试不自愈，直接 failed。
  "DRAFT_SCHEMA_INVALID",
  "DRAFT_EXTRA_FIELD",
  "DRAFT_UNSAFE_CONTENT",
  "DRAFT_OVER_LENGTH",
]);

/**
 * manual_action 错误：需要管理员人工介入（目标缺失/许可不完整/归属不完整/歧义等），
 * Worker 绝不自动重试，operation 进入 manual_action 终态，等待管理员显式 retry。
 * 它是一个【独立、显式】的人工处理分类，不是任意错误的默认兜底；也绝不被伪装成 succeeded。
 */
export const MANUAL_ACTION_ERROR_CODES = new Set([
  // 工单 05 seam 修复（Ticket 04→05）：WIKI manual_action 契约。见 P1-2。
  "WIKI_PAGE_NOT_FOUND",
  "WIKI_REVISION_NOT_FOUND",
  "WIKI_LICENSE_INCOMPLETE",
  "WIKI_ATTRIBUTION_INCOMPLETE",
  "WIKI_AMBIGUOUS",
  // 工单 06 seam（Ticket 06）：DRAFT manual_action 契约。认证/预算/缺来源/模型身份不足需人工。
  "DRAFT_AUTH_FAILED",
  "DRAFT_BUDGET_EXCEEDED",
  "DRAFT_SOURCE_MISSING",
  "DRAFT_MODEL_IDENTITY_INSUFFICIENT",
]);

export type ErrorDisposition = "retryable" | "permanent" | "manual_action";

/**
 * 把 handler 抛出的错误规范化并分类为 retryable / permanent / manual_action。
 * 未知错误码保守视为可重试（transient），由 maxAttempts 兜底，避免把可自愈失败
 * 错误标记为永久或人工。
 */
export function classifyError(code: string | undefined | null): ErrorDisposition {
  if (code === undefined || code === null || code === "") return "retryable";
  if (RETRYABLE_ERROR_CODES.has(code)) return "retryable";
  if (PERMANENT_ERROR_CODES.has(code)) return "permanent";
  if (MANUAL_ACTION_ERROR_CODES.has(code)) return "manual_action";
  return "retryable";
}

// ---- 错误摘要脱敏 ----

/**
 * 把错误详情脱敏为受限长度、不含换行/秘密线索的安全摘要。
 * 采用白名单式安全文本策略：
 *   - 不信任 Error.message 原文；
 *   - 脱敏 password/token/cookie/secret/apiKey/authorization/bearer/session/storage key/path/
 *     file path/connection string/URL credential/query secret/长高熵 token；
 *   - 移除控制字符并压缩空白；
 *   - 限制 <= ERROR_SUMMARY_MAX_LENGTH。
 */
const UNSAFE_CHARS = /[\r\n\p{Cc}]/gu;

/** 键值对型秘密（key=value）与 Bearer/会话/密钥表单。 */
const SECRET_PATTERNS = [
  /password\s*[=:：]?\s*\S+/gi,
  /(?:passwd|pwd)\s*[=:：]?\s*\S+/gi,
  /token\s*[=:：]?\s*\S+/gi,
  /access[-_]?key\s*[=:：]?\s*\S+/gi,
  /secret\s*[=:：]?\s*\S+/gi,
  /cookie\s*[=:：]?\s*\S+/gi,
  /session\s*[=:：]?\s*\S+/gi,
  /(?:authorization|auth)\s*[=:：]?\s*\S+/gi,
  /bearer\s+[a-z0-9._-]+/gi,
  /api[-_]?key\s*[=:：]?\s*\S+/gi,
];

/** URL 凭据 / query secret。 */
const URL_CRED_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^@\s]+@/gi;
const QUERY_SECRET_PATTERN = /([?&](?:token|key|secret|password|signature|sig)=)[^&\s#]+/gi;

/** 长高熵 token（>= 24 字符的字母数字混合串，避免误伤普通词）。 */
const HIGH_ENTROPY_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g;

/** 存储键 / 路径线索。 */
const PATH_PATTERN =
  /(?:storage[_-]?key|file[_-]?path|connection[_-]?string|path|root[_-]?dir)\s*[=:]\s*[\S]+/gi;

/** 裸绝对路径（/seg/seg/... 或 C:\... 或 ~/...）。 */
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/|~\/)[^\s"'`]+/g;

export const ERROR_SUMMARY_MAX_LENGTH = 500;

/** 稳定、无秘密的安全占位（当原始摘要不可信时）。 */
export const SAFE_ERROR_SUMMARY = "任务执行失败，请查看受限诊断记录";

export function sanitizeErrorSummary(
  detail: string | unknown,
  maxLength = ERROR_SUMMARY_MAX_LENGTH,
): string {
  const raw = typeof detail === "string" ? detail : (JSON.stringify(detail) ?? "");
  let out = raw.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  // 依次应用秘密脱敏（每个模式替换后不留原文）。
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  out = out.replace(URL_CRED_PATTERN, "[redacted]@");
  out = out.replace(QUERY_SECRET_PATTERN, "$1[redacted]");
  out = out.replace(HIGH_ENTROPY_PATTERN, "[redacted]");
  out = out.replace(PATH_PATTERN, "$1=[redacted]");
  out = out.replace(ABSOLUTE_PATH_PATTERN, "[redacted]");
  // 再次清理控制字符与空白（脱敏替换可能引入）。
  out = out.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (out.length > maxLength) out = `${out.slice(0, maxLength - 1)}…`;
  return out;
}

/**
 * 把 handler 抛出的错误映射为稳定、无秘密的摘要。
 *
 * 安全策略：
 *   - 已知固定错误码（RETRYABLE / PERMANENT 集合）→ 使用固定的领域文案，不信任原始 message；
 *   - 未知/非固定错误码 → 一律用固定安全占位（绝不持久化原始 message，避免未来规则遗漏导致原文回显）；
 *   - 只有"已识别但希望保留少量脱敏上下文"的错误码才走 sanitizeErrorSummary（当前无此需求，
 *     因此所有路径都返回固定文案或固定占位）。
 */
const FIXED_ERROR_SUMMARIES: Record<string, string> = {
  OPERATION_TRANSIENT: "任务执行临时失败，等待自动重试",
  OPERATION_PERMANENT: "任务执行永久失败",
  OPERATION_TARGET_MISSING: "目标任务缺失",
  OPERATION_INVALID_PAYLOAD: "任务载荷无效",
  OPERATION_ALREADY_SUCCEEDED: "任务已完成",
  OPERATION_MAX_ATTEMPTS_EXCEEDED: "任务已达到最大尝试次数",
  OPERATION_HANDLER_MISSING: "未注册的 operation handler",
  OPERATION_ABORTED: "任务已中止",
  // 工单 05 seam 修复（Ticket 04→05）：WIKI 错误固定、脱敏摘要契约。
  // 只存储固定领域文案，绝不保存 provider 原文（含响应正文/标题/词条片段/路径/密钥）。
  WIKI_TRANSIENT: "Wiki 数据源临时失败，等待自动重试",
  WIKI_RESPONSE_MALFORMED: "Wiki 数据源响应格式异常",
  WIKI_RESPONSE_TOO_LARGE: "Wiki 数据源响应过大",
  WIKI_UNSAFE_CONTENT: "Wiki 数据源包含不安全内容",
  WIKI_PROVIDER_CONTRACT: "Wiki 数据源提供者契约不符",
  WIKI_PAGE_NOT_FOUND: "Wiki 页面不存在，需人工确认",
  WIKI_REVISION_NOT_FOUND: "Wiki 修订版本不存在，需人工确认",
  WIKI_LICENSE_INCOMPLETE: "Wiki 来源许可信息不完整，需人工补充",
  WIKI_ATTRIBUTION_INCOMPLETE: "Wiki 来源归属信息不完整，需人工补充",
  WIKI_AMBIGUOUS: "Wiki 目标存在歧义，需人工确认",
  // 工单 06 seam：DRAFT 错误固定、脱敏摘要契约（Ticket 06 DeepSeek draft）。
  // 只存储固定领域文案，绝不保存 prompt / provider response / 例句 / 密钥 / 路径。
  DRAFT_TRANSIENT: "DeepSeek 草稿临时失败，等待自动重试",
  DRAFT_EMPTY_OUTPUT: "模型返回空内容",
  DRAFT_INVALID_JSON: "草稿解析失败",
  DRAFT_SCHEMA_INVALID: "草稿内容不合规",
  DRAFT_EXTRA_FIELD: "草稿内容不合规",
  DRAFT_UNSAFE_CONTENT: "草稿含不安全内容",
  DRAFT_OVER_LENGTH: "草稿内容过长",
  DRAFT_RATE_LIMIT: "服务繁忙，稍后重试",
  DRAFT_SERVER_ERROR: "服务暂时不可用",
  DRAFT_NETWORK_ERROR: "网络连接失败",
  DRAFT_TIMEOUT: "请求超时",
  DRAFT_AUTH_FAILED: "认证失败，请检查配置",
  DRAFT_BUDGET_EXCEEDED: "预算/配额不足",
  DRAFT_SOURCE_MISSING: "来源事实缺失或存在歧义",
  DRAFT_MODEL_IDENTITY_INSUFFICIENT: "模型身份不足，需人工确认",
};

export function safeErrorSummary(errorCode: string | undefined, rawMessage?: string): string {
  if (errorCode && FIXED_ERROR_SUMMARIES[errorCode]) {
    // 已知固定错误码：使用固定领域文案（绝不回显敏感原值，也不依赖原始 message 的脱敏）。
    return FIXED_ERROR_SUMMARIES[errorCode]!;
  }
  // 未知错误码或缺失：固定安全占位，绝不持久化原始 message。
  void rawMessage;
  return SAFE_ERROR_SUMMARY;
}

// ---- 管理员重试资格 ----

/**
 * 管理员重试只允许针对 failed / manual_action 状态。
 * running / queued / retry_wait / succeeded 一律拒绝：运行中并发执行会重复业务意图，
 * 已成功 no-op 不应被重排，排队/退避中的任务不应被人工抢占。
 */
export function isRetryEligible(status: OperationStatus): boolean {
  return status === "failed" || status === "manual_action";
}

// ---- 输入 hash 与 job key 确定性 ----

/**
 * operation 的 input identity hash。绑定操作类型与稳定目标身份，且用长度前缀分隔符
 * 防止构造性碰撞（`[ab, c]` 与 `[a, bc]` 不产生同一哈希）。inputVersion 参与身份：
 * 同一目标的输入内容变化（版本前进）视为新的 operation 意图。
 */
export function operationInputHash(options: {
  operationType: string;
  targetType: string;
  targetId: string;
  inputVersion: number;
}): string {
  return createHash("sha256")
    .update(
      [
        vlen(options.operationType),
        vlen(options.targetType),
        vlen(options.targetId),
        vlen(String(options.inputVersion)),
      ].join(""),
    )
    .digest("hex");
}

function vlen(s: string): string {
  return `${s.length}:${s}`;
}

/** Graphile job key 固定命名空间前缀，防与其它任务 key 碰撞。 */
export const MOTRO_JOB_KEY_NAMESPACE = "motro:op";

/**
 * 推导 Graphile `jobKey`。jobKey 含 operation UUID，但必须带固定 Motro/任务命名空间。
 * jobKey 不能作为唯一幂等防线——应用 UNIQUE + operation 状态机才是最终事实。
 */
export function operationJobKey(operationId: string): string {
  return `${MOTRO_JOB_KEY_NAMESPACE}:${operationId}`;
}

// ---- Lease 到期恢复扫描（工单 04 修复） ----

/**
 * recovery job 的 Graphile jobKey 命名空间。独立于普通 enqueue（motro:op），
 * 保证原 job（已被消费/删除）与恢复 job 不因相同 jobKey 冲突。
 */
export const MOTRO_RECOVERY_JOB_KEY_NAMESPACE = "motro:ops:recover";

/**
 * recovery job 的最小 Graphile 投递/重投预算。
 *
 * 边界契约（工单 04 收口）：
 *   - Graphile job `max_attempts` 只是【投递载体】的重投预算（N 次总投递，N-1 次重投），
 *     绝不是 Motro 业务 attempt 次数；业务 attempt 的真实上限由
 *     `application_operations.max_attempts` + `claimOperation`/`executeOperation` 的状态机
 *     决定，Graphile 的重投永远不能替代它。
 *   - recovery job 是【租约到期后的挽救投递】。它的 Graphile 重投预算必须独立于业务
 *     max_attempts 的一个底线：即使业务 max_attempts 很小（如 1），recovery job 也必须
 *    至少有 RECOVERY_MAX_ATTEMPTS 次可用的投递/重投机会，避免因业务上限把挽救 job 本身
 *    饿死成"一次性投递"，导致 lease 到期后的 operation 永久卡在 running。
 *   - 该重投不会产生重复业务 attempt：每次 recovery job 投递只是再次运行 claimOperation，
 *     由 lease + claim_token + 状态机去重（succeeded/failed/manual_action no-op，running
 *     未过期 no-op），且租约已过期时才合法推进新 attempt。
 */
export const RECOVERY_MAX_ATTEMPTS = 5;

/** 获取 recovery job 的 Graphile max_attempts：业务上限与 recovery 底线取较大者。 */
export function recoveryJobMaxAttempts(businessMaxAttempts: number): number {
  return Math.max(RECOVERY_MAX_ATTEMPTS, businessMaxAttempts);
}

/**
 * 推导一个【稳定】的 recovery job identity。
 *
 * jobKey 唯一性由 operationId + claimToken 联合决定（同一 operationId 用随机生成
 * 的唯一 claim_token 作为 recovery epoch，见 `generateRecoveryEpoch`）。Graphile 在
 * job 成功完成后会删除该 jobKey，因此：
 *   - 恢复成功后重新 enqueue（管理员重试/新 recovery）使用新的 claim token → 不会
 *     被旧的已删除 jobKey 永久挡住；jobKey 生命周期不会导致下一次合法恢复失效；
 *   - 并发 recovery 扫描对同一 operation 的同一 claim token 只能投递一个 job
 *     （graphile worker 的 jobKey 唯一性去重），从而保证同一 operation 不产生多个
 *     有效 recovery job（图结核对 jobKey 唯一约束为 —— 最终防线）。
 */
export function recoveryJobKey(operationId: string, claimToken: string): string {
  return `${MOTRO_RECOVERY_JOB_KEY_NAMESPACE}:${operationId}:${claimToken}`;
}

/**
 * 生成一个随机的 recovery epoch（即该 running operation 当前未过期的 claim token）。
 * 作为 recovery job identity 的一部分，在断言「仍是 running + expired」后读取，保证：
 *   - job identity 从 operation 行权威事实派生（不依赖进程内存计数）；
 *   - 若 old worker 静默覆盖了新 claim token，并发扫描会读到不同的 token，从而得到
 *     不同的 jobKey —— 不产生重复推进，也让后续合法恢复不被错误 jobKey 永久阻断。
 */
export function generateRecoveryEpoch(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * recovery 候选的权威 where 子句：只处理
 *   status = running 且 lease_expires_at IS NOT NULL 且 lease_expires_at < now()。
 * 非 running、未过期、已完成、无 lease 的 operation 一律不进入恢复队列。
 */
export function recoveryCandidateWhere(): string {
  return `status = 'running'
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < now()`;
}

// ---- Task payload schema ----

/** task identifier / queue name 必须是可打印 ASCII 且低基数（禁止 UUID 作为 queue name）。 */
export const TASK_IDENTIFIER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const QUEUE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidTaskIdentifier(value: string): boolean {
  return TASK_IDENTIFIER_RE.test(value) && !/[A-Za-z0-9]{36}/.test(value.replace(/-/g, ""));
}

export function isValidQueueName(value: string): boolean {
  if (!QUEUE_NAME_RE.test(value)) return false;
  // 低基数：禁 UUID 载体（strip 连字符后出现 32 位十六进制则拒绝）。
  return !looksLikeUuidEmbedded(value);
}

/**
 * 稳定 task payload：只允许不透明 operationId 与 inputVersion。
 * 任何额外字段（文件内容、导入行原文、storage key、供应商请求/响应、Cookie、
 * Token、密钥、路径）都会被拒绝。
 */
export interface OperationTaskPayload {
  operationId: string;
  inputVersion: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 禁止出现在 payload 中的敏感字段名（拒绝额外字段时自然覆盖）。 */
const SENSITIVE_FIELD_PATTERNS = [
  /password/i,
  /token/i,
  /cookie/i,
  /secret/i,
  /api[-_]?key/i,
  /storage[-_]?(key|path)/i,
  /file[-_]?path/i,
  /content/i,
  /raw/i,
  /payload/i,
  /response/i,
  /provider/i,
];

export type PayloadValidationResult =
  | { ok: true; payload: OperationTaskPayload }
  | {
      ok: false;
      code: "INVALID_UUID" | "EXTRA_FIELD" | "SENSITIVE_FIELD" | "BAD_TYPE";
      message: string;
    };

/**
 * 严格校验一个未知 payload 对象只包含稳定的 operationId 与 inputVersion，
 * 拒绝额外字段、敏感字段、非 UUID operationId 与错误类型。
 */
export function validateOperationPayload(value: unknown): PayloadValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "BAD_TYPE", message: "payload 必须是对象" };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) {
    if (SENSITIVE_FIELD_PATTERNS.some((re) => re.test(key))) {
      return { ok: false, code: "SENSITIVE_FIELD", message: `payload 含敏感字段：${key}` };
    }
  }
  const allowed = new Set(["operationId", "inputVersion"]);
  for (const key of keys) {
    if (!allowed.has(key)) {
      return { ok: false, code: "EXTRA_FIELD", message: `payload 含额外字段：${key}` };
    }
  }
  const operationId = record["operationId"];
  const inputVersion = record["inputVersion"];
  if (typeof operationId !== "string" || !UUID_RE.test(operationId)) {
    return { ok: false, code: "INVALID_UUID", message: "operationId 必须是 UUID" };
  }
  if (typeof inputVersion !== "number" || !Number.isInteger(inputVersion) || inputVersion < 1) {
    return { ok: false, code: "BAD_TYPE", message: "inputVersion 必须是正整数" };
  }
  return { ok: true, payload: { operationId, inputVersion } };
}

// ---- 重试资格 / job key 分隔符碰撞测试辅助 ----

/**
 * 断言队列名/task identifier 不含 UUID：把一个字符串里的连字符去除后，
 * 若出现一段 32 位十六进制则判定为疑似 UUID 载体（低基数守卫的一部分）。
 */
export function looksLikeUuidEmbedded(value: string): boolean {
  const stripped = value.replace(/-/g, "");
  return /[0-9a-f]{32}/i.test(stripped);
}

// ---- claim / lease 模型 ----

/**
 * 生成一个不透明的 worker claim token（随机、不可猜测）。claim token 在操作中唯一标识
 * 一次领取，重复 job / 过期 worker 必须校验归属后才可推进。
 */
export function generateClaimToken(): string {
  // 使用 crypto.randomUUID（无 `node:crypto` 依赖由调用方注入；此处用全局 crypto）。
  return globalThis.crypto.randomUUID();
}

/** lease 默认时长（毫秒）：与 worker 配置 WORKER_LEASE_MS 对齐，默认 60s。 */
export const DEFAULT_LEASE_MS = 60_000;

/** 判定一个 running operation 的 lease 是否已过期。 */
export function isLeaseExpired(
  leaseExpiresAt: Date | string | null | undefined,
  now: Date,
): boolean {
  if (leaseExpiresAt === null || leaseExpiresAt === undefined) return false;
  return new Date(leaseExpiresAt).getTime() < now.getTime();
}

/**
 * claim 判定：
 * - queued / retry_wait：可以领取（无 lease 或旧 lease 无意义）；
 * - running 且 lease 未过期：重复 job 必须 no-op；
 * - running 且 lease 已过期：允许安全重领；
 * - succeeded：永久 no-op；
 * - failed / manual_action：旧 job 必须 no-op（只能由管理员重试命令先转 queued）。
 */
export function claimDecision(options: {
  status: OperationStatus;
  leaseExpiresAt: Date | string | null | undefined;
  now: Date;
}): "claimable" | "noop" | "reclaimable" {
  if (options.status === "queued" || options.status === "retry_wait") return "claimable";
  if (options.status === "running") {
    return isLeaseExpired(options.leaseExpiresAt, options.now) ? "reclaimable" : "noop";
  }
  // succeeded / failed / manual_action
  return "noop";
}

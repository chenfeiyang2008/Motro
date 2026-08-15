"use client";

// 管理端用户管理页（账号）：本票唯一主操作是「添加用户」。
// 职责：查看账号列表、创建 learner/admin、仅一次展示一次性密码、停用/重置其他账号。
// 安全边界（最高优先级）：
//   - 一次性密码只存在于本组件内存，仅在成功响应后展示；关闭/取消/路由切换/刷新即从内存清除；
//   - 绝不写入 URL / localStorage / sessionStorage / 日志 / 错误消息 / 页面标题 / 审计 UI；
//   - API 返回的 password_hash / session token / 审计原始 payload 永不进入页面状态或日志。
// 幂等：创建/重置每次真正的新提交生成 UUID Idempotency-Key；网络或可重试错误重试复用同一键；
//       编辑字段后再次提交生成新键。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAdminUser,
  disableAdminUser,
  listAdminUsers,
  resetAdminUserPassword,
  type AdminUser,
  type AdminUserRole,
} from "@/lib/api";
import { fetchMe } from "@/lib/auth";

const ROLE_LABEL: Record<AdminUserRole, string> = { learner: "学习者", admin: "管理员" };
const STATUS_LABEL: Record<AdminUser["status"], string> = {
  active: "活跃",
  disabled: "已停用",
};

function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.().toString() ??
    `usr-${Math.random().toString(36).slice(2)}-${Date.now()}`
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

// ---- 一次性密码展示层：仅内存，关闭即清除 ----
function OneTimePasswordLayer({
  displayName,
  username,
  oneTimePassword,
  mode,
  onConfirm,
  onDismiss,
}: {
  displayName: string;
  username: string;
  oneTimePassword: string;
  mode: "created" | "reset";
  onConfirm: (copied: boolean) => void;
  onDismiss: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyAndConfirm(): Promise<void> {
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(oneTimePassword);
        copied = true;
      }
    } catch {
      copied = false;
    }
    setCopyState(copied ? "copied" : "failed");
    if (copied) onConfirm(true);
  }

  return (
    <div className="otp-backdrop" role="presentation">
      <div
        className="otp-layer glass-surface glass-surface--regular"
        role="dialog"
        aria-modal="true"
        aria-labelledby="otp-title"
      >
        <h2 id="otp-title" className="otp-title">
          一次性密码{mode === "created" ? "已创建" : "已重置"}
        </h2>
        <p className="otp-account">
          {displayName} · {username}
        </p>
        <p className="otp-warning" role="note">
          该密码仅显示一次，首次登录必须修改。关闭或取消后将无法再次查看。
        </p>
        <div className="otp-value" data-testid="otp-password" aria-label="一次性密码">
          {oneTimePassword}
        </div>
        {copyState === "failed" && (
          <p className="form-error otp-copy-error" role="alert">
            复制失败，请手动记下密码。
          </p>
        )}
        {copyState === "copied" && (
          <p className="form-success otp-copy-ok" role="status">
            已复制并确认保存。
          </p>
        )}
        <div className="otp-actions">
          <button type="button" className="secondary" onClick={onDismiss}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => void copyAndConfirm()}>
            复制并确认已保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- 二次确认层：停用 / 重置 ----
function ConfirmLayer({
  title,
  body,
  confirmLabel,
  busy,
  danger,
  onConfirm,
  onDismiss,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="confirm-layer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onDismiss} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={danger ? "secondary danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminUsersPage() {
  // ---- 当前登录管理员 id（禁用“停用自己”）----
  const [meId, setMeId] = useState<string | null>(null);

  // ---- 列表 ----
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  // ---- 添加用户表单（受控，不做乐观写入）----
  const [showCreate, setShowCreate] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<AdminUserRole>("learner");
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [budget, setBudget] = useState("20");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createFieldErrors, setCreateFieldErrors] = useState<string>("");
  const [createRetryable, setCreateRetryable] = useState(false);
  // 创建意图幂等键：字段与首提快照一致则复用；编辑字段后重提生成新键。
  const createIntentRef = useRef<{
    username: string;
    displayName: string;
    role: AdminUserRole;
    timezone: string;
    budget: string;
    key: string;
  } | null>(null);

  // ---- 一次性密码（仅内存）----
  const [otp, setOtp] = useState<{
    oneTimePassword: string;
    displayName: string;
    username: string;
    mode: "created" | "reset";
  } | null>(null);

  // ---- 停用 / 重置确认 ----
  const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null);
  const [disableBusy, setDisableBusy] = useState(false);
  const [disableError, setDisableError] = useState("");
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  // 重置意图幂等键：同一目标重试复用同一 key。
  const resetIntentRef = useRef<{ userId: string; key: string } | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setListError("");
    const res = await listAdminUsers();
    setLoading(false);
    if (!res.ok || !res.data) {
      setListError(res.error?.message ?? "加载用户失败，请重试");
      return;
    }
    setUsers(res.data.items);
  }, []);

  useEffect(() => {
    void loadList();
    void (async () => {
      const me = await fetchMe();
      if (me.ok && me.user) setMeId(me.user.id);
    })();
  }, [loadList]);

  // ---- 创建 ----
  const budgetNum = Math.floor(Number(budget));
  const validBudget = Number.isFinite(budgetNum) && budgetNum >= 1 && budgetNum <= 120;

  function resetCreateForm(): void {
    setUsername("");
    setDisplayName("");
    setRole("learner");
    setTimezone("Asia/Shanghai");
    setBudget("20");
    setCreateError("");
    setCreateFieldErrors("");
    setCreateRetryable(false);
    createIntentRef.current = null;
  }

  function sameCreateIntent(prior: NonNullable<typeof createIntentRef.current>): boolean {
    return (
      prior.username === username.trim() &&
      prior.displayName === displayName.trim() &&
      prior.role === role &&
      prior.timezone === timezone.trim() &&
      prior.budget === budget.trim()
    );
  }

  async function onCreate(): Promise<void> {
    const uname = username.trim();
    const dname = displayName.trim();
    const tz = timezone.trim();
    setCreateError("");
    setCreateFieldErrors("");

    // 客户端预校验：用户名规则 3-32 小写字母/数字/._-
    if (!/^[a-z0-9_.-]{3,32}$/.test(uname)) {
      setCreateFieldErrors("用户名需为 3–32 位小写字母、数字、点、下划线或连字符");
      return;
    }
    if (dname.length < 1) {
      setCreateFieldErrors("请填写显示名");
      return;
    }
    if (!validBudget) {
      setCreateFieldErrors("每日学习预算需为 1–120 分钟");
      return;
    }

    const cur = {
      username: uname,
      displayName: dname,
      role,
      timezone: tz,
      budget: budget.trim(),
    };
    const prior = createIntentRef.current;
    if (!prior || !sameCreateIntent(prior)) {
      createIntentRef.current = { ...cur, key: uuid() };
      setCreateRetryable(false);
    }
    const key = createIntentRef.current!.key;

    setCreating(true);
    const res = await createAdminUser(
      {
        username: uname,
        displayName: dname,
        role,
        timezone: tz,
        dailyBudgetMinutes: budgetNum,
      },
      key,
    );
    setCreating(false);

    if (!res.ok || !res.data) {
      // 网络(0)或服务端 retryable → 保留意图键，重试复用；明确不可重试错误 → 编辑后生成新键。
      const retryable = res.status === 0 || res.error?.retryable === true;
      if (!retryable) createIntentRef.current = null;
      setCreateRetryable(!!retryable);
      const fe = res.error?.fieldErrors?.[0];
      const msg =
        fe?.message ??
        res.error?.message ??
        (retryable ? "网络连接失败，请点击重试" : "创建用户失败，请重试");
      if (res.status === 409) setCreateFieldErrors(msg);
      else setCreateError(msg);
      return;
    }

    // 成功：清理意图；把一次性密码送进仅内存的确认层；关闭表单。
    createIntentRef.current = null;
    setCreateRetryable(false);
    setShowCreate(false);
    resetCreateForm();
    setOtp({
      oneTimePassword: res.data.oneTimePassword,
      displayName: res.data.user.displayName,
      username: res.data.user.username,
      mode: "created",
    });
    await loadList();
  }

  // ---- 停用 ----
  async function onDisableConfirm(): Promise<void> {
    if (!disableTarget) return;
    setDisableBusy(true);
    setDisableError("");
    const res = await disableAdminUser(disableTarget.id);
    setDisableBusy(false);
    if (!res.ok) {
      setDisableError(res.error?.message ?? "停用失败，请重试");
      return;
    }
    setDisableTarget(null);
    setDisableError("");
    await loadList();
  }

  // ---- 重置 ----
  async function onResetConfirm(): Promise<void> {
    if (!resetTarget) return;
    setResetBusy(true);
    setResetError("");
    // 每个重置目标生成一次意图键；失败重试复用，成功/换目标后清空。
    if (!resetIntentRef.current || resetIntentRef.current.userId !== resetTarget.id) {
      resetIntentRef.current = { userId: resetTarget.id, key: uuid() };
    }
    const key = resetIntentRef.current.key;
    const res = await resetAdminUserPassword(resetTarget.id, key);
    setResetBusy(false);
    if (!res.ok || !res.data) {
      const retryable = res.status === 0 || res.error?.retryable === true;
      if (!retryable) resetIntentRef.current = null;
      setResetError(
        res.error?.message ?? (retryable ? "网络连接失败，请点击重试" : "重置失败，请重试"),
      );
      return;
    }
    resetIntentRef.current = null;
    setResetTarget(null);
    setResetError("");
    setOtp({
      oneTimePassword: res.data.oneTimePassword,
      displayName: res.data.user.displayName,
      username: res.data.user.username,
      mode: "reset",
    });
    await loadList();
  }

  // ---- 路由切换/卸载时确保 OTP 从内存清除（关闭层也会置 null）。 ----
  const otpOnDismiss = useCallback(() => setOtp(null), []);

  return (
    <section className="admin-users">
      <div className="users-header">
        <h1>用户管理</h1>
        <button type="button" className="primary" onClick={() => setShowCreate(true)}>
          添加用户
        </button>
      </div>

      {listError !== "" && (
        <p className="form-error users-list-error" role="alert">
          {listError}
          <button type="button" className="secondary" onClick={() => void loadList()}>
            重试
          </button>
        </p>
      )}
      {loading && (
        <div className="users-skeleton" aria-label="加载用户">
          <span className="skeleton-row" />
          <span className="skeleton-row" />
          <span className="skeleton-row" />
          <span className="skeleton-row" />
        </div>
      )}
      {!loading && listError === "" && users.length === 0 && (
        <p className="users-empty" role="status">
          还没有账号。点击“添加用户”创建第一个账号。
        </p>
      )}
      {!loading && listError === "" && users.length > 0 && (
        <div className="users-table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th scope="col">显示名</th>
                <th scope="col">用户名</th>
                <th scope="col">角色</th>
                <th scope="col">状态</th>
                <th scope="col">时区</th>
                <th scope="col">每日预算</th>
                <th scope="col">创建时间</th>
                <th scope="col">
                  <span className="visually-hidden">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = meId === u.id;
                const isDisabled = u.status === "disabled";
                return (
                  <tr key={u.id} data-testid="user-row">
                    <td data-label="显示名">
                      <span className="user-display-name">{u.displayName}</span>
                    </td>
                    <td data-label="用户名">{u.username}</td>
                    <td data-label="角色">
                      <span className={`users-role users-role--${u.role}`}>
                        {ROLE_LABEL[u.role]}
                      </span>
                    </td>
                    <td data-label="状态">
                      <span className={`users-status users-status--${u.status}`}>
                        {STATUS_LABEL[u.status]}
                      </span>
                    </td>
                    <td data-label="时区">{u.timezone}</td>
                    <td data-label="每日预算">{u.dailyBudgetMinutes} 分钟</td>
                    <td data-label="创建时间">{formatTime(u.createdAt)}</td>
                    <td data-label="操作" className="users-actions">
                      {isSelf ? (
                        <span className="users-self-hint" title="不能停用自己的账号">
                          当前账号
                        </span>
                      ) : (
                        <>
                          {!isDisabled && (
                            <button
                              type="button"
                              className="secondary danger user-action-btn"
                              onClick={() => {
                                setDisableError("");
                                setDisableTarget(u);
                              }}
                            >
                              停用
                            </button>
                          )}
                          <button
                            type="button"
                            className="secondary user-action-btn"
                            onClick={() => {
                              setResetError("");
                              setResetTarget(u);
                            }}
                          >
                            重置密码
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 添加用户受控表单层 */}
      {showCreate && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="create-user-layer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
          >
            <h2 id="create-title">添加用户</h2>
            {createError !== "" && (
              <p className="form-error" role="alert">
                {createError}
              </p>
            )}
            {createFieldErrors !== "" && (
              <p className="form-error" role="alert">
                {createFieldErrors}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void onCreate();
              }}
              noValidate
            >
              <div className="create-field">
                <label htmlFor="create-username">登录用户名</label>
                <input
                  id="create-username"
                  autoComplete="off"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="例如：zhang.wei"
                />
                <p className="create-field-hint">3–32 位：小写字母、数字、点、下划线、连字符</p>
              </div>
              <div className="create-field">
                <label htmlFor="create-displayname">显示名</label>
                <input
                  id="create-displayname"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="例如：张伟"
                />
              </div>
              <div className="create-field">
                <label htmlFor="create-role">角色</label>
                <select
                  id="create-role"
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value as AdminUserRole);
                    setCreateFieldErrors("");
                  }}
                >
                  <option value="learner">学习者</option>
                  <option value="admin">管理员</option>
                </select>
                {role === "admin" && (
                  <p className="create-risk-hint" role="note">
                    管理员可访问管理端并创建、停用、重置其他账号。请谨慎授权。
                  </p>
                )}
              </div>
              <div className="create-field">
                <label htmlFor="create-timezone">IANA 时区</label>
                <input
                  id="create-timezone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="create-field">
                <label htmlFor="create-budget">每日学习预算（分钟）</label>
                <input
                  id="create-budget"
                  inputMode="numeric"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
                <p className="create-field-hint">1–120 分钟</p>
              </div>
              <div className="create-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    resetCreateForm();
                    setShowCreate(false);
                  }}
                  disabled={creating}
                >
                  取消
                </button>
                <button type="submit" className="primary" disabled={creating}>
                  {creating ? "创建中…" : createRetryable ? "重试创建" : "创建"}
                </button>
              </div>
            </form>
            {createRetryable && (
              <p className="create-retry-hint">
                网络中断或响应丢失。点击“重试创建”会复用同一次创建意图（同一
                Idempotency-Key），不会重复创建账号。
              </p>
            )}
          </div>
        </div>
      )}

      {/* 停用二次确认 */}
      {disableTarget && (
        <ConfirmLayer
          title={`停用 ${disableTarget.displayName}？`}
          body="这会撤销该用户的全部登录会话；停用后该账号将无法登录。"
          confirmLabel="确认停用"
          danger
          busy={disableBusy}
          onConfirm={() => void onDisableConfirm()}
          onDismiss={() => setDisableTarget(null)}
        />
      )}
      {disableError !== "" && !disableTarget && (
        <p className="form-error users-action-error" role="alert">
          {disableError}
        </p>
      )}

      {/* 重置二次确认 */}
      {resetTarget && (
        <ConfirmLayer
          title={`重置 ${resetTarget.displayName} 的密码？`}
          body="这会撤销该用户的全部登录会话，并生成一个新的仅显示一次的一次性密码。"
          confirmLabel="确认重置"
          busy={resetBusy}
          onConfirm={() => void onResetConfirm()}
          onDismiss={() => setResetTarget(null)}
        />
      )}
      {resetError !== "" && !resetTarget && (
        <p className="form-error users-action-error" role="alert">
          {resetError}
        </p>
      )}

      {/* 一次性密码确认层（仅内存；取消/确认即清除） */}
      {otp && (
        <OneTimePasswordLayer
          displayName={otp.displayName}
          username={otp.username}
          oneTimePassword={otp.oneTimePassword}
          mode={otp.mode}
          onConfirm={() => otpOnDismiss()}
          onDismiss={otpOnDismiss}
        />
      )}
    </section>
  );
}

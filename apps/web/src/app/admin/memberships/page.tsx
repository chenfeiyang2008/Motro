"use client";

import "./styles.css";
import { useEffect, useState } from "react";
import {
  createIdempotencyKey,
  grantAdminUserMembership,
  listAdminMemberships,
  revokeAdminUserMembership,
  renewAdminUserMembership,
  setAdminUserDailyLimit,
  type AdminMembershipList,
  type MembershipSchedulePayload,
} from "@/lib/api";

type MembershipItem = AdminMembershipList["items"][number];
type Action = "grant" | "renew" | "revoke" | "daily-limit";

const STATE_LABEL: Record<MembershipItem["state"], string> = {
  free: "免费",
  member: "会员",
  expired: "已过期",
};
const ACTION_LABEL: Record<NonNullable<MembershipItem["lastAction"]>, string> = {
  grant: "开通",
  renew: "续期",
  revoke: "撤销",
};

function formatDate(value: string | null): string {
  if (!value) return "不限";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

export default function AdminMembershipsPage() {
  const [items, setItems] = useState<MembershipItem[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<MembershipItem["state"] | "">("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<MembershipItem | null>(null);
  const [action, setAction] = useState<Action>("grant");
  const [mode, setMode] = useState<MembershipSchedulePayload["mode"]>("duration");
  const [durationDays, setDurationDays] = useState("30");
  const [expiresAt, setExpiresAt] = useState("");
  const [dailyLimitMinutes, setDailyLimitMinutes] = useState("15");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (selected === null || saving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, saving]);

  async function load(reset = true): Promise<void> {
    setLoading(true);
    setError("");
    const options: Parameters<typeof listAdminMemberships>[0] = { limit: 50 };
    if (search) options.q = search;
    if (state) options.state = state;
    if (!reset && cursor) options.cursor = cursor;
    const result = await listAdminMemberships(options);
    setLoading(false);
    if (!result.ok || !result.data) {
      setError(result.error?.message ?? "会员列表加载失败，请重试");
      return;
    }
    setItems((previous) => (reset ? result.data!.items : [...previous, ...result.data!.items]));
    setCursor(result.data.nextCursor ?? null);
    setHasMore(result.data.hasMore);
  }

  useEffect(() => {
    void load(true);
  }, [search, state]);

  function openAction(item: MembershipItem, nextAction: Action): void {
    setSelected(item);
    setAction(nextAction);
    setMode("duration");
    setDurationDays("30");
    setExpiresAt("");
    setDailyLimitMinutes(String(item.dailyLimitMinutes ?? 15));
    setActionError("");
  }

  async function submitAction(): Promise<void> {
    if (!selected) return;
    if (action === "daily-limit") {
      const minutes = Number(dailyLimitMinutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
        setActionError("请输入 0 至 1440 之间的整数分钟数");
        return;
      }
      setSaving(true);
      setActionError("");
      const result = await setAdminUserDailyLimit(selected.userId, minutes, createIdempotencyKey());
      setSaving(false);
      if (!result.ok) {
        setActionError(result.error?.message ?? "保存失败，请重试");
        return;
      }
      setSelected(null);
      await load(true);
      return;
    }
    if (action === "revoke") {
      await revoke();
      return;
    }
    let schedule: MembershipSchedulePayload;
    if (mode === "duration") {
      schedule = { mode, durationDays: Number(durationDays) };
    } else if (mode === "until") {
      const parsed = new Date(expiresAt);
      if (!expiresAt || Number.isNaN(parsed.getTime())) {
        setActionError("请选择有效的到期时间");
        return;
      }
      schedule = { mode, expiresAt: parsed.toISOString() };
    } else {
      schedule = { mode: mode ?? "indefinite" };
    }
    setSaving(true);
    setActionError("");
    const key = createIdempotencyKey();
    const result =
      action === "grant"
        ? await grantAdminUserMembership(selected.userId, { plan: "member", ...schedule }, key)
        : await renewAdminUserMembership(selected.userId, schedule, key);
    setSaving(false);
    if (!result.ok) {
      setActionError(result.error?.message ?? "操作失败，请重试");
      return;
    }
    setSelected(null);
    await load(true);
  }

  async function revoke(): Promise<void> {
    if (!selected) return;
    setSaving(true);
    setActionError("");
    const result = await revokeAdminUserMembership(selected.userId, createIdempotencyKey());
    setSaving(false);
    if (!result.ok) {
      setActionError(result.error?.message ?? "撤销失败，请重试");
      return;
    }
    setSelected(null);
    await load(true);
  }

  return (
    <section className="admin-memberships admin-memberships-page">
      <header className="users-header admin-membership-heading">
        <div>
          <h1>会员管理</h1>
        </div>
        <button
          className="secondary"
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
        >
          刷新
        </button>
      </header>
      <div className="users-filter admin-membership-toolbar" role="search">
        <div className="admin-membership-filter-field">
          <label htmlFor="membership-search">搜索用户</label>
          <input
            id="membership-search"
            value={query}
            placeholder="用户名或显示名"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setSearch(query.trim());
            }}
          />
        </div>
        <button className="secondary" type="button" onClick={() => setSearch(query.trim())}>
          搜索
        </button>
        <div className="admin-membership-filter-field admin-membership-filter-field--state">
          <label htmlFor="membership-state">状态</label>
          <select
            id="membership-state"
            value={state}
            onChange={(event) => setState(event.target.value as typeof state)}
          >
            <option value="">全部</option>
            <option value="free">免费</option>
            <option value="member">会员</option>
            <option value="expired">已过期</option>
          </select>
        </div>
      </div>
      {error && (
        <div className="admin-membership-error" role="alert">
          {error}
          <button type="button" onClick={() => void load(true)}>
            重试
          </button>
        </div>
      )}
      <div className="admin-membership-table-wrap">
        <table className="admin-membership-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>角色 / 账号</th>
              <th>会员状态</th>
              <th>开始时间</th>
              <th>到期时间</th>
              <th>非会员时长</th>
              <th>最后操作</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.userId} data-testid={`member-row-${item.userId}`}>
                <td>
                  <strong>{item.displayName}</strong>
                  <small>{item.username}</small>
                </td>
                <td>
                  {item.role === "admin" ? "管理员" : "学习者"}
                  <small>{item.accountStatus === "active" ? "正常" : "已停用"}</small>
                </td>
                <td>
                  <span
                    className={`admin-membership-status admin-membership-status--${item.state}`}
                  >
                    {STATE_LABEL[item.state]}
                  </span>
                </td>
                <td>{formatDate(item.startedAt)}</td>
                <td>{formatDate(item.expiresAt)}</td>
                <td>
                  <span>{item.dailyLimitMinutes} 分钟 / 日</span>
                  <button
                    className="admin-membership-inline-action"
                    type="button"
                    data-testid={`member-daily-limit-inline-${item.userId}`}
                    onClick={() => openAction(item, "daily-limit")}
                  >
                    编辑
                  </button>
                </td>
                <td>{item.lastAction ? ACTION_LABEL[item.lastAction] : "—"}</td>
                <td className="admin-membership-row-actions">
                  {item.state === "member" ? (
                    <button
                      type="button"
                      data-testid={`member-renew-${item.userId}`}
                      onClick={() => openAction(item, "renew")}
                    >
                      续期
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid={`member-grant-${item.userId}`}
                      onClick={() => openAction(item, "grant")}
                    >
                      开通
                    </button>
                  )}
                  {item.state === "member" && (
                    <button
                      className="danger"
                      type="button"
                      data-testid={`member-revoke-${item.userId}`}
                      onClick={() => openAction(item, "revoke")}
                    >
                      撤销
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`member-daily-limit-${item.userId}`}
                    onClick={() => openAction(item, "daily-limit")}
                  >
                    时长
                  </button>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={8} className="admin-membership-empty">
                  暂无匹配用户
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {loading && <p className="admin-membership-loading">正在加载会员列表…</p>}
      {hasMore && (
        <button
          className="admin-membership-load-more"
          type="button"
          onClick={() => void load(false)}
          disabled={loading}
        >
          加载更多
        </button>
      )}

      {selected && (
        <div
          className="admin-membership-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) setSelected(null);
          }}
        >
          <div
            className="admin-membership-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="membership-panel-title"
          >
            <div className="admin-membership-panel-header">
              <h2 id="membership-panel-title">
                {action === "grant"
                  ? "开通会员"
                  : action === "renew"
                    ? "续期会员"
                    : action === "daily-limit"
                      ? "编辑非会员时长"
                      : "撤销会员"}{" "}
                · {selected.displayName}
              </h2>
              <button type="button" onClick={() => setSelected(null)} aria-label="关闭">
                ×
              </button>
            </div>
            {action === "daily-limit" && (
              <label>
                非会员每日时长（分钟）
                <input
                  type="number"
                  min={0}
                  max={1440}
                  step={1}
                  autoFocus
                  value={dailyLimitMinutes}
                  onChange={(event) => setDailyLimitMinutes(event.target.value)}
                />
                <small>会员不受此值限制；设为 0 将暂停非会员学习。</small>
              </label>
            )}
            {action !== "revoke" && action !== "daily-limit" && (
              <>
                <div className="admin-membership-mode">
                  <label>
                    <input
                      type="radio"
                      checked={mode === "duration"}
                      onChange={() => setMode("duration")}
                    />
                    按天数
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={mode === "until"}
                      onChange={() => setMode("until")}
                    />
                    到期日期
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={mode === "indefinite"}
                      onChange={() => setMode("indefinite")}
                    />
                    永久
                  </label>
                </div>
                {mode === "duration" && (
                  <label>
                    天数
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={durationDays}
                      onChange={(event) => setDurationDays(event.target.value)}
                    />
                  </label>
                )}
                {mode === "until" && (
                  <label>
                    到期时间
                    <input
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(event) => setExpiresAt(event.target.value)}
                    />
                  </label>
                )}
              </>
            )}
            {actionError && (
              <p className="admin-membership-error" role="alert">
                {actionError}
              </p>
            )}
            <div className="admin-membership-panel-actions">
              <button
                className={
                  action === "revoke" ? "admin-membership-danger" : "admin-membership-primary"
                }
                type="button"
                onClick={() => void submitAction()}
                disabled={saving}
              >
                {saving
                  ? "处理中…"
                  : action === "grant"
                    ? "确认开通"
                    : action === "renew"
                      ? "确认续期"
                      : action === "daily-limit"
                        ? "保存时长"
                        : "确认撤销"}
              </button>
              {action !== "revoke" && action !== "daily-limit" && selected.state === "member" && (
                <button
                  className="admin-membership-danger"
                  type="button"
                  onClick={() => openAction(selected, "revoke")}
                  disabled={saving}
                >
                  撤销会员
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

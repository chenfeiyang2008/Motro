"use client";

// 管理端经验 / XP 账本页（Ticket 19）：真实、只读、可追溯的 ledger + append-only 补正/作废。
// 原则（严格）：
//   - 账本事实只读；绝无"直接把 XP 改成 1000"的普通输入框。
//   - correction/void 是【新 append-only xp_entries 条目】，关联原 entry、理由、操作者、幂等键、审计。
//   - 原 entry 不 UPDATE、不 DELETE。金额上限/重复提交/并发由后端最终约束。
//   - 周挑战积分与日常 XP 分开；本页只展示日常 XP ledger。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  correctAdminXp,
  listAdminXp,
  listAdminXpUsers,
  voidAdminXp,
  type AdminXpEntry,
  type AdminXpUserSummary,
} from "@/lib/api";

const KIND_LABEL: Record<string, string> = {
  initial_review: "首学",
  due_review: "到期复习",
  correction: "补正",
  void: "作废",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.().toString() ??
    `xp-${Math.random().toString(36).slice(2)}-${Date.now()}`
  );
}

export default function AdminXpPage() {
  const [entries, setEntries] = useState<AdminXpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  // 用户选择器
  const [users, setUsers] = useState<AdminXpUserSummary[]>([]);
  const [userQuery, setUserQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<string>("");

  // 筛选
  const [kind, setKind] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // 补正/作废目标与表单
  const [activeEntry, setActiveEntry] = useState<AdminXpEntry | null>(null);
  const [action, setAction] = useState<"void" | "correct" | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const intentKeyRef = useRef<string | null>(null);

  const loadUsers = useCallback(async () => {
    const res = await listAdminXpUsers(userQuery);
    if (res.ok && res.data) setUsers(res.data.items);
  }, [userQuery]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setListError("");
      const res = await listAdminXp({
        userId: selectedUser || undefined,
        kind: kind || undefined,
        cursor: reset ? null : cursor,
        limit: 50,
      });
      setLoading(false);
      if (!res.ok || !res.data) {
        setListError(res.error?.message ?? "加载 XP 账本失败，请重试");
        return;
      }
      if (reset) setEntries(res.data.items);
      else setEntries((prev) => [...prev, ...res.data!.items]);
      setCursor(res.data.nextCursor ?? null);
      setHasMore(res.data.hasMore);
    },
    [selectedUser, kind, cursor],
  );

  useEffect(() => {
    void load(true);
  }, [selectedUser, kind]);

  function loadMore(): void {
    if (cursor) void load(false);
  }

  async function submitCorrection(): Promise<void> {
    if (!activeEntry) return;
    if (
      action === "correct" &&
      (isNaN(Number(amount)) || Number(amount) === 0 || !Number.isInteger(Number(amount)))
    ) {
      setError("补正金额必须为非零整数（正数=增加，负数=减少）");
      return;
    }
    if (reason.trim() === "") {
      setError("必须填写理由");
      return;
    }
    setBusy(true);
    setError("");
    if (!intentKeyRef.current) intentKeyRef.current = uuid();
    const key = intentKeyRef.current;
    let res;
    if (action === "void") {
      res = await voidAdminXp(activeEntry.id, reason.trim(), key);
    } else {
      res = await correctAdminXp(activeEntry.id, Number(amount), reason.trim(), key);
    }
    setBusy(false);
    if (!res.ok) {
      const retryable = res.status === 0 || res.error?.retryable === true;
      if (!retryable) intentKeyRef.current = null;
      setError(
        res.error?.message ??
          (retryable
            ? "网络连接失败，请点击重试"
            : action === "void"
              ? "作废失败，请重试"
              : "补正失败，请重试"),
      );
      return;
    }
    intentKeyRef.current = null;
    setAction(null);
    setActiveEntry(null);
    setAmount("");
    setReason("");
    void load(true);
  }

  function openAction(entry: AdminXpEntry, a: "void" | "correct"): void {
    setActiveEntry(entry);
    setAction(a);
    setAmount("");
    setReason("");
    setError("");
  }

  return (
    <section className="admin-xp">
      <div className="xp-header">
        <div>
          <h1>经验 / 学习数据</h1>
          <p className="xp-intro">
            经验值（XP）账本由不可变事实构成。补正与作废以新增的审计条目表达，不改写原始记录。
          </p>
        </div>
        <button type="button" className="secondary" onClick={() => void load(true)}>
          刷新
        </button>
      </div>

      <div className="xp-toolbar">
        <div className="xp-field">
          <label htmlFor="xp-user">用户（按 XP 汇总选择）</label>
          <select
            id="xp-user"
            value={selectedUser}
            onChange={(e) => setSelectedUser(e.target.value)}
          >
            <option value="">全部用户</option>
            {users.map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.username} · 净 {u.netXp} XP
              </option>
            ))}
          </select>
        </div>
        <div className="xp-field">
          <label htmlFor="xp-kind">类型</label>
          <select id="xp-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="xp-field">
          <label htmlFor="xp-user-search">搜索用户</label>
          <input
            id="xp-user-search"
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder="用户名/显示名…"
          />
        </div>
      </div>

      {listError !== "" && (
        <p className="form-error" role="alert">
          {listError}
          <button type="button" className="secondary" onClick={() => void load(true)}>
            重试
          </button>
        </p>
      )}

      {loading && entries.length === 0 && (
        <p className="xp-status" role="status">
          正在加载 XP 账本…
        </p>
      )}
      {!loading && listError === "" && entries.length === 0 && (
        <p className="xp-empty" role="status">
          还没有 XP 记录。
        </p>
      )}

      {entries.length > 0 && (
        <div className="xp-ledger-wrap">
          <table className="xp-ledger">
            <caption>XP 账本（只读；按时间倒序）</caption>
            <thead>
              <tr>
                <th scope="col">用户</th>
                <th scope="col">类型</th>
                <th scope="col">金额</th>
                <th scope="col">规则版本</th>
                <th scope="col">来源 review 事件</th>
                <th scope="col">时间</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} data-testid="xp-entry-row">
                  <td>{e.username ?? e.userId.slice(0, 8)}</td>
                  <td>
                    <span className={`xp-kind xp-kind--${e.reason}`}>
                      {KIND_LABEL[e.reason] ?? e.reason}
                      {e.referencesXpEntryId ? " " : ""}
                    </span>
                  </td>
                  <td className={e.amount < 0 ? "xp-amount xp-amount--neg" : "xp-amount"}>
                    {e.amount > 0 ? `+${e.amount}` : e.amount}
                  </td>
                  <td>v{e.ruleVersion}</td>
                  <td>
                    {e.reviewEventId ? (
                      <code className="xp-event-id">{e.reviewEventId.slice(0, 8)}…</code>
                    ) : (
                      "—"
                    )}
                    {e.referencesXpEntryId ? (
                      <span className="xp-ref" title="关联的原条目">
                        ↲ #{e.referencesXpEntryId.slice(0, 8)}
                      </span>
                    ) : null}
                  </td>
                  <td>{formatTime(e.createdAt)}</td>
                  <td>
                    {e.reason !== "correction" && e.reason !== "void" && (
                      <span className="xp-actions">
                        <button
                          type="button"
                          className="secondary danger xp-action-btn"
                          onClick={() => openAction(e, "void")}
                        >
                          作废
                        </button>
                        <button
                          type="button"
                          className="secondary xp-action-btn"
                          onClick={() => openAction(e, "correct")}
                        >
                          补正
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && listError === "" && hasMore && (
        <div className="xp-load-more">
          <button type="button" className="secondary" onClick={loadMore}>
            加载更多
          </button>
        </div>
      )}

      {action !== null && activeEntry && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="xp-action-layer"
            role="dialog"
            aria-modal="true"
            aria-label={`${action === "void" ? "作废" : "补正"} XP`}
          >
            <h2>
              {action === "void"
                ? `作废 ${activeEntry.amount} XP`
                : `补正 ${activeEntry.amount} XP`}
            </h2>
            <p className="xp-action-note">
              目标：{activeEntry.username ?? activeEntry.userId.slice(0, 8)} ·
              {KIND_LABEL[activeEntry.reason]} · v{activeEntry.ruleVersion}。
              {action === "void"
                ? "将新增一条金额为该笔负值的作废记录（append-only），原始记录保持不变。"
                : "将新增一条 signed 补正记录（append-only），原始记录保持不变。"}
            </p>
            {action === "correct" && (
              <div className="xp-field">
                <label htmlFor="xp-amount">补正金额（正=增加，负=减少）</label>
                <input
                  id="xp-amount"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            )}
            <div className="xp-field">
              <label htmlFor="xp-reason">理由</label>
              <textarea
                id="xp-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
              />
            </div>
            {error !== "" && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <p className="xp-action-audit">该操作会记录操作者、理由、时间与幂等键，供审计追溯。</p>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setAction(null)}
              >
                取消
              </button>
              <button
                type="button"
                className={action === "void" ? "primary danger" : "primary"}
                disabled={busy}
                onClick={() => void submitCorrection()}
              >
                {busy ? "提交中…" : action === "void" ? "确认作废" : "确认补正"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

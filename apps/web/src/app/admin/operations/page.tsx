"use client";

// 管理端任务状态页（阶段 6 工单 04）：
// 列出后台操作（类型、目标安全摘要、状态、尝试次数、最近更新时间）。
// 唯一主操作在详情页（重试）；本页只读分页。绝不展示供应商正文、原文件内容、路径或密钥。
import Link from "next/link";
import { useEffect, useState } from "react";
import { listOperations, type OperationSummary } from "@/lib/api";

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  retry_wait: "等待重试",
  succeeded: "已成功",
  failed: "已失败",
  manual_action: "待人工处理",
};

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

const PAGE_SIZE = 20;

export default function AdminOperationsPage() {
  const [items, setItems] = useState<OperationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [targetTypeFilter, setTargetTypeFilter] = useState("");
  const [errorCodeFilter, setErrorCodeFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  async function load(resetCursor: boolean): Promise<void> {
    setLoading(true);
    setError("");
    const opts: {
      status?: string;
      operationType?: string;
      targetType?: string;
      errorCode?: string;
      cursor: string | null;
      limit?: number;
    } = { cursor: resetCursor ? null : cursor, limit: PAGE_SIZE };
    if (statusFilter !== "") opts.status = statusFilter;
    if (targetTypeFilter !== "") opts.targetType = targetTypeFilter;
    if (errorCodeFilter !== "") opts.errorCode = errorCodeFilter;
    const res = await listOperations(opts);
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "加载任务状态失败，请重试");
      return;
    }
    if (resetCursor) setItems(res.data.items);
    else setItems((prev) => [...prev, ...res.data!.items]);
    setCursor(res.data.nextCursor ?? null);
    setHasMore(res.data.hasMore ?? res.data.nextCursor !== null);
  }

  useEffect(() => {
    void load(true);
  }, [statusFilter, targetTypeFilter, errorCodeFilter]);

  function onLoadMore(): void {
    if (cursor) void load(false);
  }

  return (
    <section className="admin-operations">
      <h1>任务状态</h1>
      <p className="operations-intro">
        查看导入与补全等后台操作的执行状态。此处只显示安全摘要；失败任务可从详情页由管理员重试。
      </p>

      <div className="operations-toolbar">
        <div className="operations-filter">
          <label htmlFor="op-status-filter">状态过滤</label>
          <select
            id="op-status-filter"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setCursor(null);
            }}
          >
            <option value="">全部</option>
            <option value="queued">排队中</option>
            <option value="running">运行中</option>
            <option value="retry_wait">等待重试</option>
            <option value="succeeded">已成功</option>
            <option value="failed">已失败</option>
            <option value="manual_action">待人工处理</option>
          </select>
        </div>
        <div className="operations-filter">
          <label htmlFor="op-target-filter">目标类型</label>
          <select
            id="op-target-filter"
            value={targetTypeFilter}
            onChange={(e) => {
              setTargetTypeFilter(e.target.value);
              setCursor(null);
            }}
          >
            <option value="">全部</option>
            <option value="import_batch">导入批次</option>
            <option value="enrichment_draft">补全草稿</option>
          </select>
        </div>
        <div className="operations-filter">
          <label htmlFor="op-error-filter">最近错误码</label>
          <input
            id="op-error-filter"
            value={errorCodeFilter}
            onChange={(e) => {
              setErrorCodeFilter(e.target.value);
              setCursor(null);
            }}
            placeholder="例如 PARSE_ERROR…"
          />
        </div>
        <button type="button" className="secondary" onClick={() => void load(true)}>
          刷新
        </button>
        {!loading && error === "" && items.length > 0 && (
          <span className="operations-count">{items.length} 条</span>
        )}
      </div>

      {loading && <p role="status">正在加载任务状态…</p>}
      {!loading && error !== "" && (
        <p role="alert">
          {error}
          <button type="button" className="secondary" onClick={() => void load(true)}>
            重试
          </button>
        </p>
      )}
      {!loading && error === "" && items.length === 0 && (
        <p className="operations-empty">还没有后台操作记录。</p>
      )}
      {!loading && error === "" && items.length > 0 && (
        <div className="operations-table-wrap">
          <table className="operations-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>目标</th>
                <th>状态</th>
                <th>尝试</th>
                <th>最近更新</th>
              </tr>
            </thead>
            <tbody>
              {items.map((op) => (
                <tr key={op.id}>
                  <td>{op.operationType}</td>
                  <td>
                    <Link href={`/admin/operations/${op.id}`} className="operations-link">
                      {op.targetType} · {op.targetId}
                    </Link>
                  </td>
                  <td>
                    <span className={`operations-status operations-status--${op.status}`}>
                      {statusLabel(op.status)}
                    </span>
                  </td>
                  <td>
                    {op.attemptCount}/{op.maxAttempts}
                  </td>
                  <td>{formatTime(op.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && error === "" && hasMore && (
        <div className="operations-pagination">
          <button type="button" className="secondary" onClick={onLoadMore}>
            加载更多
          </button>
        </div>
      )}
    </section>
  );
}

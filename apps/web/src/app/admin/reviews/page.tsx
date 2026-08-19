"use client";

// 管理端审核队列页（Ticket 18）：信息完整、表格优先的工作台。
// 职责：列出来源完整、等待审核的草稿（含可补全 manual_action 的有效投影），
// 点击行进入详情页做不可变审核决定。
// 安全边界：绝不展示 provider payload / prompt / 哈希 / 内部路径；
// 列表只消费 ReviewDraftListItemDto 的投影字段（spelling、来源授权事实、decision）。
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { listReviewDrafts, type ReviewDraftListItem } from "@/lib/api";
import {
  reviewDecisionLabel,
  reviewStatusBadgeClass,
  reviewStatusLabel,
} from "@/lib/review-helpers";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

export default function AdminReviewsQueuePage() {
  const [items, setItems] = useState<ReviewDraftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [manualActionFilter, setManualActionFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setListError("");
      const res = await listReviewDrafts({
        status: statusFilter || undefined,
        manualAction: (manualActionFilter as "resolvable" | "non_resolvable") || undefined,
        cursor: reset ? null : cursor,
        limit: 50,
      });
      setLoading(false);
      if (!res.ok || !res.data) {
        setListError(res.error?.message ?? "加载审核队列失败，请重试");
        return;
      }
      if (reset) setItems(res.data.items);
      else setItems((prev) => [...prev, ...res.data!.items]);
      setCursor(res.data.nextCursor ?? null);
      setHasMore(res.data.hasMore ?? false);
    },
    [statusFilter, manualActionFilter, cursor],
  );

  useEffect(() => {
    void load(true);
  }, [statusFilter, manualActionFilter]);

  function loadMore(): void {
    if (cursor) void load(false);
  }

  return (
    <section className="admin-reviews">
      <div className="reviews-header">
        <div>
          <h1>审核</h1>
          <p className="reviews-intro">
            对 AI 生成的词条释义进行不可变的人工审核决定。每一条决定都会留下可审计的审核记录。
          </p>
        </div>
        <button type="button" className="secondary" onClick={() => void load(true)}>
          刷新
        </button>
      </div>

      <div className="reviews-filter">
        <div className="xp-field">
          <label htmlFor="review-status">状态</label>
          <select
            id="review-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">全部</option>
            <option value="draft_ready">待审核</option>
            <option value="manual_action">待处理</option>
          </select>
        </div>
        <div className="xp-field">
          <label htmlFor="review-manual">manual_action 分类</label>
          <select
            id="review-manual"
            value={manualActionFilter}
            onChange={(e) => setManualActionFilter(e.target.value)}
          >
            <option value="">全部</option>
            <option value="resolvable">可解除</option>
            <option value="non_resolvable">不可解除</option>
          </select>
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

      {loading && (
        <p className="reviews-status" role="status">
          正在加载审核队列…
        </p>
      )}

      {!loading && listError === "" && items.length === 0 && (
        <div className="reviews-empty" role="status">
          <p>当前没有等待审核的词条。新的 Wikt语音/DeepSeek 草稿会在来源完整后出现在这里。</p>
          <Link href="/admin/imports" className="secondary">
            前往导入
          </Link>
        </div>
      )}

      {!loading && listError === "" && items.length > 0 && (
        <div className="reviews-table-wrap">
          <table className="reviews-table">
            <caption>待审草稿队列</caption>
            <thead>
              <tr>
                <th scope="col">拼写</th>
                <th scope="col">状态</th>
                <th scope="col">来源</th>
                <th scope="col">许可证</th>
                <th scope="col">最新决定</th>
                <th scope="col">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((draft) => (
                <tr key={draft.draftId}>
                  <td>
                    <Link
                      href={`/admin/reviews/${draft.draftId}`}
                      className="reviews-link"
                      data-testid="review-row-link"
                    >
                      {draft.spelling}
                    </Link>
                  </td>
                  <td>
                    <span className={`review-status ${reviewStatusBadgeClass(draft.status)}`}>
                      {reviewStatusLabel(draft.status)}
                    </span>
                  </td>
                  <td title={draft.source.sourceUrl}>
                    {draft.source.sourceName} · {draft.source.revisionId.slice(0, 8)}
                  </td>
                  <td>{draft.source.licenseName}</td>
                  <td>
                    {draft.decisionType ? (
                      <span className="review-decision-pill">
                        {reviewDecisionLabel(draft.decisionType)}
                      </span>
                    ) : (
                      <span className="review-muted">—</span>
                    )}
                  </td>
                  <td>{formatTime(draft.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && listError === "" && items.length > 0 && (
        <p className="reviews-caption">
          队列按创建时间倒序（分页加载）。来源 URL 与完整 provenance 请在详情页查看。
        </p>
      )}

      {!loading && listError === "" && hasMore && (
        <div className="reviews-load-more">
          <button type="button" className="secondary" onClick={loadMore}>
            加载更多
          </button>
        </div>
      )}
    </section>
  );
}

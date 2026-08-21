"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getAdminOverview, type AdminOverview, type AdminOverviewItem } from "@/lib/api";
import { ADMIN_ICONS, type AdminIconName } from "@/components/admin/icons";
import "./admin-overview.css";

// ---- 队列元数据（4 类待处理） ----
const QUEUE_META = [
  {
    key: "reviews",
    label: "待审核",
    href: "/admin/reviews",
    icon: "reviews",
    empty: "暂无待审核内容",
  },
  {
    key: "imports",
    label: "导入异常",
    href: "/admin/imports",
    icon: "import",
    empty: "暂无异常导入",
  },
  {
    key: "operations",
    label: "失败任务",
    href: "/admin/operations",
    icon: "operations",
    empty: "暂无失败任务",
  },
  {
    key: "publishing",
    label: "待发布课程",
    href: "/admin/courses",
    icon: "courses",
    empty: "暂无待发布课程",
  },
] as const;

// ---- 规模指标元数据（5 项）：图标 + 标签 + 是否显示比例条 ----
const METRIC_META: {
  key: keyof AdminOverview["metrics"];
  label: string;
  icon: AdminIconName;
  /** 比例分母的指标 key；null 则本卡不显示比例条 */
  ratioOver?: keyof AdminOverview["metrics"];
  ratioLabel?: string;
  note?: string;
}[] = [
  { key: "users", label: "活跃用户", icon: "users" },
  { key: "members", label: "会员", icon: "crown", ratioOver: "users", ratioLabel: "会员渗透率" },
  { key: "activeLexiconEntries", label: "启用词条", icon: "lexicon" },
  { key: "courses", label: "课程", icon: "courses", note: "全部课程" },
  {
    key: "publishedCourses",
    label: "已发布课程",
    icon: "courses",
    ratioOver: "courses",
    ratioLabel: "发布率",
  },
];

const STATUS_LABEL: Record<string, string> = {
  draft_ready: "待审核",
  manual_action: "需人工处理",
  failed: "失败",
  validating: "校验中",
  draft: "草稿",
  private: "未发布",
  published: "已发布",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { hour12: false });
}

/** 相对时间：用于近期待办列表，减少长日期噪音。 */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = now - date.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN");
}

/** 比例（0..1）；除数为 0 或 无比例定义返回 null。 */
export function metricRatio(
  metrics: AdminOverview["metrics"],
  key: keyof AdminOverview["metrics"],
  over: keyof AdminOverview["metrics"] | undefined,
): number | null {
  if (!over) return null;
  const num = metrics[key].total;
  const den = metrics[over].total;
  if (den <= 0) return null;
  return Math.min(num / den, 1);
}

function itemMeta(item: AdminOverviewItem): string {
  return ("errorCode" in item && item.errorCode) || STATUS_LABEL[item.status] || item.status;
}

function itemTime(item: AdminOverviewItem): string {
  return "updatedAt" in item ? item.updatedAt : item.createdAt;
}

function itemHref(key: (typeof QUEUE_META)[number]["key"], id: string, fallback: string): string {
  if (key === "reviews") return `${fallback}/${id}`;
  if (key === "publishing") return `/admin/courses/${id}/publishing`;
  return fallback;
}

/** 环形图：单个 donut。value/total 决定圆弧占比，中心显示中心标签。 */
function Donut({
  value,
  total,
  label,
  accent,
}: {
  value: number;
  total: number;
  label: string;
  accent?: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const r = 15.9155; // 周长 100 单位
  const dash = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="admin-overview__donut" role="img" aria-label={`${label} ${pct}%`}>
      <svg viewBox="0 0 42 42" aria-hidden="true">
        <circle className="admin-overview__donut-track" cx="21" cy="21" r={r} />
        <circle
          className="admin-overview__donut-value"
          style={{ stroke: accent }}
          cx="21"
          cy="21"
          r={r}
          strokeDasharray={`${dash} ${100 - dash}`}
          strokeDashoffset="25"
        />
      </svg>
      <div className="admin-overview__donut-center">
        <strong>{pct}%</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

export default function AdminHomePage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const res = await getAdminOverview();
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "加载管理概览失败，请重试");
      return;
    }
    setOverview(res.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingTotal = overview
    ? Object.values(overview.queues).reduce((total, queue) => total + queue.count, 0)
    : 0;

  return (
    <section className="admin-overview" aria-labelledby="admin-overview-title">
      {/* 顶部身份区：一行可视总结 */}
      <header className="admin-overview__header">
        <div>
          <p className="admin-overview__eyebrow">WORKSPACE</p>
          <h1 id="admin-overview-title">管理概览</h1>
          {overview && (
            <p className="admin-overview__updated">更新于 {formatTime(overview.generatedAt)}</p>
          )}
        </div>
        <div className="admin-overview__header-actions">
          {overview && (
            <nav className="admin-overview__badges" aria-label="状态总览">
              <Link
                href="/admin/reviews"
                className={`admin-overview__badge admin-overview__badge--${overview.queues.reviews.count > 0 ? "brand" : "muted"}`}
              >
                <span className="admin-overview__badge-dot" aria-hidden="true" />
                {overview.queues.reviews.count} 待审核
              </Link>
              <Link
                href="/admin/operations"
                className={`admin-overview__badge admin-overview__badge--${overview.queues.imports.count + overview.queues.operations.count > 0 ? "error" : "muted"}`}
              >
                <span className="admin-overview__badge-dot" aria-hidden="true" />
                {overview.queues.imports.count + overview.queues.operations.count} 需排查
              </Link>
              <Link
                href="/admin/courses"
                className={`admin-overview__badge admin-overview__badge--${overview.queues.publishing.count > 0 ? "warn" : "muted"}`}
              >
                <span className="admin-overview__badge-dot" aria-hidden="true" />
                {overview.queues.publishing.count} 待发布
              </Link>
            </nav>
          )}
          <button
            type="button"
            className="admin-overview__refresh"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "加载中…" : "刷新"}
          </button>
        </div>
      </header>

      {loading && overview === null && (
        <div className="admin-overview__skeleton" role="status" aria-label="正在加载管理概览">
          <span />
          <span />
          <span />
          <span />
        </div>
      )}

      {error !== "" && (
        <div className="admin-overview__error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {overview && error === "" && (
        <>
          {/* 规模指标区：大数字卡 + 图标 + 比例条 */}
          <div className="admin-overview__section-heading">
            <h2>当前规模</h2>
            <span>实时汇总</span>
          </div>
          <dl className="admin-overview__metrics" aria-label="规模概览">
            {METRIC_META.map((meta) => {
              const total = overview.metrics[meta.key].total;
              const ratio = metricRatio(overview.metrics, meta.key, meta.ratioOver);
              const Icon = ADMIN_ICONS[meta.icon];
              return (
                <div key={meta.key} className="admin-overview__metric">
                  <div className="admin-overview__metric-icon">
                    <Icon aria-hidden="true" />
                  </div>
                  <dt className="admin-overview__metric-label">{meta.label}</dt>
                  <dd className="admin-overview__metric-value">{total.toLocaleString("zh-CN")}</dd>
                  {ratio !== null ? (
                    <div
                      className="admin-overview__metric-ratio"
                      aria-label={`${meta.ratioLabel} ${Math.round(ratio * 100)}%`}
                    >
                      <span className="admin-overview__ratio-track">
                        <span
                          className="admin-overview__ratio-fill"
                          style={{ width: `${Math.round(ratio * 100)}%` }}
                        />
                      </span>
                      <small>
                        {meta.ratioLabel} {Math.round(ratio * 100)}%
                      </small>
                    </div>
                  ) : meta.note ? (
                    <small className="admin-overview__metric-note">{meta.note}</small>
                  ) : null}
                </div>
              );
            })}
          </dl>

          {/* 图表区：环形分布（快照占比） */}
          <div className="admin-overview__section-heading">
            <h2>组成分布</h2>
            <span>基于当前数据</span>
          </div>
          <div className="admin-overview__donuts">
            <Donut
              value={overview.metrics.publishedCourses.total}
              total={overview.metrics.courses.total}
              label="课程已发布"
              accent="var(--color-brand-600)"
            />
            <Donut
              value={overview.metrics.members.total}
              total={overview.metrics.users.total}
              label="会员占比"
              accent="var(--color-crown, var(--color-brand-700))"
            />
            <Donut
              value={overview.metrics.activeLexiconEntries.total}
              total={Math.max(overview.metrics.activeLexiconEntries.total, 1)}
              label="启用词条"
              accent="var(--color-success)"
            />
          </div>

          {/* 待处理区：左「优先处理」堆叠 + 右「各队列明细」 */}
          <div className="admin-overview__section-heading">
            <h2>待处理</h2>
            <span>
              {pendingTotal > 0 ? `${pendingTotal.toLocaleString("zh-CN")} 项需要关注` : "当前清空"}
            </span>
          </div>
          <div className="admin-overview__work">
            {/* 左栏：优先处理面板 */}
            <section className="admin-overview__priority" aria-label="优先处理">
              <div className="admin-overview__priority-heading">
                <h3>优先处理</h3>
                <span>{pendingTotal > 0 ? "按队列分布" : "无需处理"}</span>
              </div>
              {pendingTotal > 0 ? (
                <div
                  className="admin-overview__stack"
                  role="img"
                  aria-label={`共 ${pendingTotal} 项待处理`}
                >
                  {QUEUE_META.map((meta) => {
                    const count = overview.queues[meta.key].count;
                    if (count === 0) return null;
                    return (
                      <Link
                        key={meta.key}
                        href={meta.href}
                        className={`admin-overview__stack-seg admin-overview__stack-seg--${meta.key}`}
                        style={{ flexGrow: count }}
                        aria-label={`${meta.label} ${count} 项`}
                      >
                        <span>{count}</span>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <p className="admin-overview__empty">当前没有需要处理的队列。</p>
              )}
              {/* 最近待办：全部队列按时间倒序合并 */}
              <div className="admin-overview__priority-list">
                {QUEUE_META.flatMap((meta) =>
                  overview.queues[meta.key].items.map((item) => {
                    const Icon = ADMIN_ICONS[meta.icon];
                    return (
                      <Link
                        key={`${meta.key}-${item.id}`}
                        href={itemHref(meta.key, item.id, meta.href)}
                        className="admin-overview__priority-item"
                      >
                        <span className="admin-overview__priority-icon">
                          <Icon aria-hidden="true" />
                        </span>
                        <span className="admin-overview__priority-label">{item.label}</span>
                        <span className="admin-overview__priority-meta">
                          {meta.label} · {itemMeta(item)}
                        </span>
                        <time dateTime={itemTime(item)}>{relativeTime(itemTime(item))}</time>
                      </Link>
                    );
                  }),
                ).sort((a, b) => {
                  const ta = (a.props["dateTime"] as string) ?? "";
                  const tb = (b.props["dateTime"] as string) ?? "";
                  return tb.localeCompare(ta);
                })}
              </div>
            </section>

            {/* 右栏：各队列明细 */}
            <div className="admin-overview__queues">
              {QUEUE_META.map((meta) => {
                const queue = overview.queues[meta.key];
                const Icon = ADMIN_ICONS[meta.icon];
                return (
                  <section
                    key={meta.key}
                    className="admin-overview__queue"
                    aria-labelledby={`queue-${meta.key}`}
                  >
                    <div className="admin-overview__queue-heading">
                      <span className="admin-overview__queue-icon">
                        <Icon aria-hidden="true" />
                      </span>
                      <h3 id={`queue-${meta.key}`}>{meta.label}</h3>
                      <strong>{queue.count}</strong>
                      <Link href={meta.href}>查看全部</Link>
                    </div>
                    {queue.items.length === 0 ? (
                      <p className="admin-overview__empty">{meta.empty}</p>
                    ) : (
                      <ul className="admin-overview__list">
                        {queue.items.slice(0, 3).map((item) => (
                          <li key={item.id}>
                            <Link href={itemHref(meta.key, item.id, meta.href)}>
                              <span className="admin-overview__item-marker" aria-hidden="true" />
                              <span className="admin-overview__item-label">{item.label}</span>
                              <span className="admin-overview__item-meta">{itemMeta(item)}</span>
                              <time dateTime={itemTime(item)}>{relativeTime(itemTime(item))}</time>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

"use client";

// 周挑战榜页：只展示后端真实返回的 Challenge Points 排行榜。
// - 排行榜只使用 server-graded Challenge Points；日常学习 XP 不参与排名（不显示为榜单分数）。
// - 空榜显示 empty state，不使用 0 或假数字。
// - opt-out 用户不出现在公开行；本人（即使 opt-out）仍可见自己的 viewerRank/viewerChallengePoints。
// - disabled 用户由后端过滤，前端不展示。
// - 401 → /login；403 → /change-password。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createIdempotencyKey,
  getMeXp,
  getWeeklyLeaderboard,
  setLeaderboardVisibility,
  type WeeklyLeaderboardFixed,
  type LeaderboardRow,
} from "@/lib/api";
import { fetchMe, fetchMeMembership } from "@/lib/auth";
import { MemberCrownBadge } from "@/components/member-crown-badge";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; data: WeeklyLeaderboardFixed };

// Preview-only rows used when the page is opened with ?preview=1. They are never
// sent to the API or persisted, and the preview banner makes their status explicit.
const PREVIEW_ROWS: LeaderboardRow[] = [
  { rank: 1, displayName: "词锋小队", challengePoints: 95, isMember: false },
  { rank: 2, displayName: "橙色闪电", challengePoints: 80, isMember: true },
  { rank: 3, displayName: "今日不摆烂", challengePoints: 65, isMember: false },
  { rank: 4, displayName: "Grammar 狂人", challengePoints: 50, isMember: false },
  { rank: 5, displayName: "早起背词", challengePoints: 35, isMember: false },
];

export default function LeaderboardPage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [rank, setRank] = useState<{ level: number; title: string } | null>(null);
  const [isMember, setIsMember] = useState(false);
  const [viewerName, setViewerName] = useState("");
  const [previewMode, setPreviewMode] = useState(false);

  // 隐私设置
  // 后端默认公开参与；无 GET 偏好接口，故初始按「默认公开」呈现，首次点击即关闭。
  const [publicVisible, setPublicVisible] = useState<boolean>(true);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibilityError, setVisibilityError] = useState("");
  // 一次“设置为某状态”的尝试可安全重放；反向切换必须使用新的 key，否则服务端会按
  // 同 key 异 payload 返回 IDEMPOTENCY_CONFLICT。
  const visibilityKeys = useRef(new Map<boolean, string>());

  const load = useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    const [res, xpRes, memberRes, meRes] = await Promise.all([
      getWeeklyLeaderboard(),
      getMeXp().catch(() => null),
      fetchMeMembership().catch(() => null),
      fetchMe().catch(() => null),
    ]);
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (!res.ok || !res.data) {
      setState({
        phase: "error",
        message:
          res.status === 0 ? "网络连接失败，可重试" : (res.error?.message ?? "加载排行榜失败"),
      });
      return;
    }
    if (memberRes?.ok && memberRes.membership?.status === "member") setIsMember(true);
    if (meRes?.user?.displayName) setViewerName(meRes.user.displayName);
    setRows(res.data.rows);
    setHasMore(res.data.hasMore);
    setCursor(res.data.nextCursor);
    if (xpRes?.ok && xpRes.data) setRank({ level: xpRes.data.level, title: xpRes.data.title });
    setState({ phase: "ready", data: res.data });
  }, [router]);

  useEffect(() => {
    const localHost =
      window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    setPreviewMode(localHost && new URLSearchParams(window.location.search).get("preview") === "1");
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (!cursor || state.phase !== "ready") return;
    const res = await getWeeklyLeaderboard({ cursor });
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (!res.ok || !res.data) return;
    // 追加到既有行；服务器为顺序权威，不自行重排。
    setRows((prev) => [...prev, ...res.data!.rows]);
    setHasMore(res.data.hasMore);
    setCursor(res.data.nextCursor);
    setState((s) => (s.phase === "ready" ? { ...s, data: res.data! } : s));
  }

  // 隐私状态：本票不读后端偏好接口（GET 不存在），初始未知 → 显示为“未知”并允许设置。
  // 仅当用户显式操作时才 POST /leaderboard/visibility（CSRF 由 apiFetch 自动处理）。

  async function togglePublic(): Promise<void> {
    if (visibilitySaving) return;
    setVisibilitySaving(true);
    setVisibilityError("");
    // 服务器响应为最终状态；网络失败后的同一意图重试复用 key，反向操作另用新 key。
    const target = !(publicVisible ?? false);
    let idempotencyKey = visibilityKeys.current.get(target);
    if (!idempotencyKey) {
      idempotencyKey = createIdempotencyKey();
      visibilityKeys.current.set(target, idempotencyKey);
    }
    const res = await setLeaderboardVisibility(target, idempotencyKey);
    setVisibilitySaving(false);
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (!res.ok || !res.data) {
      if (res.error?.code === "IDEMPOTENCY_CONFLICT") {
        visibilityKeys.current.delete(target);
      }
      setVisibilityError(res.error?.message ?? "保存公开设置失败，请重试");
      return;
    }
    visibilityKeys.current.delete(target);
    setPublicVisible(res.data.isPublic);
  }

  if (state.phase === "loading") {
    return (
      <section className="lb-page">
        <h1>周挑战榜</h1>
        <p role="status">正在加载…</p>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section className="lb-page">
        <h1>周挑战榜</h1>
        <p role="alert" className="form-error">
          {state.message}
        </p>
        <button type="button" className="secondary" onClick={() => void load()}>
          重试
        </button>
        <Link href="/" className="secondary">
          返回首页
        </Link>
      </section>
    );
  }

  const d = state.data;
  const previewRows = previewMode && rows.length === 0;
  const displayRows = previewRows ? PREVIEW_ROWS : rows;
  const hasRows = displayRows.length > 0;
  return (
    <section className="lb-page">
      <header className="lb-header">
        <h1>周挑战榜</h1>
        <p className="lb-lede">本周挑战积分榜 · 日常 XP 不计入排名。</p>
        <p className="lb-week">
          挑战周：{d.challengeWeek}（{d.weekStart.slice(0, 10)} 至 {d.weekEnd.slice(0, 10)}
          ，Asia/Shanghai）
        </p>
      </header>

      {/* 本人行：把排名、积分和段位拆成可扫描的三列，避免状态挤在一行。 */}
      <section className="lb-viewer" aria-label="我的本周挑战榜数据">
        <div className="lb-viewer-topline">
          <span className="lb-viewer-label">
            我的位置
            <MemberCrownBadge status={isMember ? "member" : undefined} size="compact" />
          </span>
          <span className="lb-viewer-period">本周挑战</span>
        </div>
        <div className="lb-viewer-stats">
          <div className="lb-viewer-stat lb-viewer-stat--rank">
            <span className="lb-viewer-stat-label">当前排名</span>
            {d.viewerRank !== null ? (
              <strong className="lb-viewer-rank">第 {d.viewerRank} 名</strong>
            ) : (
              <strong className="lb-viewer-rank lb-viewer-rank--none">未上榜</strong>
            )}
          </div>
          <div className="lb-viewer-stat">
            <span className="lb-viewer-stat-label">挑战积分</span>
            <strong className="lb-viewer-points">{d.viewerChallengePoints}</strong>
          </div>
          {rank && (
            <div className="lb-viewer-stat lb-viewer-stat--level">
              <span className="lb-viewer-stat-label">学习段位</span>
              <span className="lb-viewer-rank-badge">
                <span className="lb-viewer-rank-badge__level">Lv.{rank.level}</span>
                <span>{rank.title}</span>
              </span>
            </div>
          )}
        </div>
      </section>

      {/* 开始测验：唯一主操作。资格由 /challenge/current 的服务端响应决定（本期开放、
          已接触 ≥10 词条、未被判定不可参加）；入口统一导向服务端权威页，不在前端推算。 */}
      <div className="lb-challenge-entry">
        <Link href="/challenge" className="primary">
          开始测验
        </Link>
        <span className="lb-challenge-hint">每个词义方向每周最多得一次积分</span>
      </div>

      {previewMode && rows.length === 0 && (
        <p className="lb-preview-note" role="status">
          演示数据 · 仅用于查看界面，不计入真实榜单
        </p>
      )}

      {!hasRows ? (
        <div className="lb-empty">
          <p>本周还没有公开上榜的参与者。</p>
          <p className="lb-empty-hint">排行榜只在有真实 Challenge Points 时显示数据。</p>
        </div>
      ) : (
        <div className="lb-table-wrap">
          <table className="lb-table">
            <caption className="visually-hidden">本周挑战积分排行榜</caption>
            <thead>
              <tr>
                <th scope="col">排名</th>
                <th scope="col">参与者</th>
                <th scope="col">挑战分</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r) => {
                const isViewer = viewerName !== "" && r.displayName === viewerName;
                return (
                  <tr
                    key={`${r.displayName}-${r.rank}`}
                    className={isViewer ? "lb-row--current" : undefined}
                    data-is-viewer={isViewer || undefined}
                  >
                    <td className="lb-rank-cell">
                      <span className={`lb-rank-num${r.rank <= 3 ? ` lb-rank-num--top${r.rank}` : ""}`}>
                        {r.rank}
                      </span>
                    </td>
                    <td className="lb-participant-cell">
                      {r.displayName}
                      {r.isMember && <MemberCrownBadge status="member" size="compact" />}
                      {isViewer && <span className="lb-you-badge">我</span>}
                    </td>
                    <td className="lb-points-cell">{r.challengePoints}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <button type="button" className="secondary" onClick={() => void loadMore()}>
          加载更多
        </button>
      )}

      <p className="lb-total">
        参与总人数（含退出公开榜者）：{previewRows ? PREVIEW_ROWS.length : d.totalParticipants}
      </p>

      {/* 隐私设置放在页面底部，避免打断榜单浏览。 */}
      <div className="lb-privacy">
        <span className="lb-privacy-label">公开参与</span>
        <button
          type="button"
          className={publicVisible === false ? "secondary" : "primary"}
          disabled={visibilitySaving}
          onClick={() => void togglePublic()}
          aria-pressed={publicVisible ?? undefined}
        >
          {visibilitySaving ? "保存中…" : publicVisible === false ? "点击公开" : "点击关闭"}
        </button>
        {visibilityError !== "" && (
          <p role="alert" className="form-error">
            {visibilityError}
          </p>
        )}
        <span className="lb-privacy-hint">名次始终保留</span>
      </div>

      <Link href="/" className="lb-home-link">
        返回首页
      </Link>
    </section>
  );
}

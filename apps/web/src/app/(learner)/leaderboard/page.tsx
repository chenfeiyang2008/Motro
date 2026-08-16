"use client";

// 周挑战榜页：只展示后端真实返回的 Challenge Points 排行榜。
// - 排行榜只使用 server-graded Challenge Points；日常学习 XP 不参与排名（不显示为榜单分数）。
// - 空榜显示 empty state，不使用 0 或假数字。
// - opt-out 用户不出现在公开行；本人（即使 opt-out）仍可见自己的 viewerRank/viewerChallengePoints。
// - disabled 用户由后端过滤，前端不展示。
// - 401 → /login；403 → /change-password。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  getWeeklyLeaderboard,
  setLeaderboardVisibility,
  type WeeklyLeaderboardFixed,
  type LeaderboardRow,
} from "@/lib/api";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; data: WeeklyLeaderboardFixed };

export default function LeaderboardPage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [hasMore, setHasMore] = useState(false);

  // 隐私设置
  // 后端默认公开参与；无 GET 偏好接口，故初始按「默认公开」呈现，首次点击即关闭。
  const [publicVisible, setPublicVisible] = useState<boolean>(true);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibilityError, setVisibilityError] = useState("");
  const [visibilityKey] = useState(() =>
    typeof crypto !== "undefined" ? crypto.randomUUID() : `vis-${Date.now()}`,
  );

  const load = useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    // 服务端默认 limit=20；不显式传 limit（@IsInt 校验 query 字符串会 422）。
    const res = await getWeeklyLeaderboard();
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
    setRows(res.data.rows);
    setHasMore(res.data.hasMore);
    setCursor(res.data.nextCursor);
    setState({ phase: "ready", data: res.data });
  }, [router]);

  useEffect(() => {
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
    // 服务器响应为最终状态；失败保留已知 UI，允许重试（同一幂等键）。
    const target = !(publicVisible ?? false);
    const res = await setLeaderboardVisibility(target, visibilityKey);
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
      setVisibilityError(res.error?.message ?? "保存公开设置失败，请重试");
      return;
    }
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
  const hasRows = rows.length > 0;
  return (
    <section className="lb-page">
      <header className="lb-header">
        <h1>周挑战榜</h1>
        <p className="lb-lede">
          本周挑战积分排行榜。榜单只按 server-graded Challenge Points 排名； 日常学习
          XP、课程完成数量与个人经验都不参与排名。
        </p>
        <p className="lb-week">
          挑战周：{d.challengeWeek}（{d.weekStart.slice(0, 10)} 至 {d.weekEnd.slice(0, 10)}
          ，Asia/Shanghai）
        </p>
      </header>

      {/* 本人行 */}
      <div className="lb-viewer">
        <span className="lb-viewer-label">我的位置</span>
        {d.viewerRank !== null ? (
          <strong className="lb-viewer-rank">第 {d.viewerRank} 名</strong>
        ) : (
          <strong className="lb-viewer-rank lb-viewer-rank--none">未上榜</strong>
        )}
        <span className="lb-viewer-points">{d.viewerChallengePoints} Challenge Points</span>
      </div>

      {/* 隐私设置 */}
      <div className="lb-privacy">
        <span className="lb-privacy-label">公开参与</span>
        <button
          type="button"
          className={publicVisible === false ? "secondary" : "primary"}
          disabled={visibilitySaving}
          onClick={() => void togglePublic()}
          aria-pressed={publicVisible ?? undefined}
        >
          {visibilitySaving
            ? "保存中…"
            : publicVisible === false
              ? "当前不公开 · 点击开启"
              : "当前公开 · 点击关闭"}
        </button>
        {visibilityError !== "" && (
          <p role="alert" className="form-error">
            {visibilityError}
          </p>
        )}
        <p className="lb-privacy-hint">
          关闭后你不会出现在其他人的公开榜单行中，但仍保留个人积分与名次。
        </p>
      </div>

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
                <th scope="col">Challenge Points</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.displayName}-${r.rank}`}>
                  <td>{r.rank}</td>
                  <td>{r.displayName}</td>
                  <td>{r.challengePoints}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <button type="button" className="secondary" onClick={() => void loadMore()}>
          加载更多
        </button>
      )}

      <p className="lb-total">参与总人数（含退出公开榜者）：{d.totalParticipants}</p>
      <Link href="/" className="secondary">
        返回首页
      </Link>
    </section>
  );
}

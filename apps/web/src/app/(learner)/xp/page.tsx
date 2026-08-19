"use client";

// 个人经验概览页：只显示后端真实返回的个人 XP 数据。
// 个人经验（daily-learning XP）不进入排行榜；排行榜仅用 Challenge Points（见 /leaderboard）。
// 禁用或不可用时显示诚实提示；不伪造等级、streak、CEFR。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getMeXp, type MeXp } from "@/lib/api";
import { projectRankDisplay } from "@/lib/rank-display";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; data: MeXp }
  | { phase: "empty"; data: MeXp };

export default function XpPage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    const res = await getMeXp();
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
          res.status === 0 ? "网络连接失败，可重试" : (res.error?.message ?? "加载个人经验失败"),
      });
      return;
    }
    if (res.data.entries.length === 0 && res.data.totalXp === 0) {
      setState({ phase: "empty", data: res.data });
      return;
    }
    setState({ phase: "ready", data: res.data });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <section className="xp-page">
        <div className="xp-skeleton-heading" aria-hidden="true" />
        <div className="xp-skeleton-overview" aria-hidden="true" />
        <p role="status" className="xp-loading-copy">
          正在加载个人经验…
        </p>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section className="xp-page">
        <header className="xp-heading">
          <span className="xp-kicker">LEARNING PROGRESS</span>
          <h1>个人经验</h1>
        </header>
        <p role="alert" className="form-error">
          {state.message}
        </p>
        <div className="xp-actions">
          <button type="button" className="secondary" onClick={() => void load()}>
            重试
          </button>
          <Link href="/" className="secondary">
            返回首页
          </Link>
        </div>
      </section>
    );
  }

  if (state.phase === "empty") {
    const { data } = state;
    const rank = projectRankDisplay(data);
    return (
      <section className="xp-page">
        <header className="xp-heading">
          <span className="xp-kicker">LEARNING PROGRESS</span>
          <h1>个人经验</h1>
        </header>
        <div className="xp-empty-state">
          <span className="xp-empty-index" aria-hidden="true">
            01
          </span>
          <div>
            <p className="xp-rank-kicker">当前段位 · Lv.{rank.level}</p>
            <h2>{rank.title}</h2>
            <p>完成一次首测或到期复习，开始积累个人经验。</p>
          </div>
          <Link href="/" className="primary">
            去开始学习
          </Link>
        </div>
      </section>
    );
  }

  const { totalXp, entries, asOf } = state.data;
  const rank = projectRankDisplay(state.data);
  const hasRankProgress =
    !rank.isFallback &&
    Number.isFinite(state.data.progressPercent) &&
    Number.isFinite(state.data.levelThreshold);
  return (
    <section className="xp-page">
      <header className="xp-heading">
        <span className="xp-kicker">LEARNING PROGRESS</span>
        <h1>个人经验</h1>
      </header>

      <div className="xp-overview">
        <div className="xp-card-topline">
          <span>DAILY LEARNING</span>
          <span className="xp-card-topline-mark" aria-hidden="true">
            XP
          </span>
        </div>
        <div className="xp-total">
          <span className="xp-total-label">累计个人经验</span>
          <div className="xp-total-value">
            <strong className="xp-total-amount">{totalXp}</strong>
            <span className="xp-total-unit">XP</span>
          </div>
        </div>
        <div className="xp-rankline">
          <div>
            <span className="xp-rank-label">当前段位 · Lv.{rank.level}</span>
            <strong>{rank.title}</strong>
          </div>
          <span className="xp-rank-threshold">
            {!hasRankProgress
              ? "段位信息同步中"
              : state.data.nextLevelThreshold === null ||
                  state.data.nextLevelThreshold === undefined
                ? "已达最高段位"
                : `距离 Lv.${state.data.nextLevel} 还差 ${Math.max(
                    0,
                    state.data.nextLevelThreshold - state.data.totalXp,
                  )} XP`}
          </span>
        </div>
        <div
          className="xp-rank-progress"
          aria-label={
            hasRankProgress ? `当前段位进度 ${state.data.progressPercent}%` : "段位进度同步中"
          }
        >
          {hasRankProgress && <span style={{ width: `${state.data.progressPercent}%` }} />}
        </div>
      </div>

      <div className="xp-latest">
        <div className="xp-section-heading">
          <div>
            <h2>最近获得</h2>
          </div>
          <span className="xp-section-count">{entries.length} 条记录</span>
        </div>
        {entries.length > 0 ? (
          <ul className="xp-entries">
            {entries.slice(0, 5).map((e: MeXp["entries"][number], i: number) => (
              <li key={`${i}-${e.earnedAt}`}>
                <span className="xp-entry-marker" aria-hidden="true" />
                <div className="xp-entry-main">
                  <span className="xp-entry-reason">
                    {e.reason === "initial_review"
                      ? "首测"
                      : e.reason === "due_review"
                        ? "到期复习"
                        : e.reason}
                  </span>
                  <time className="xp-entry-time" dateTime={e.earnedAt}>
                    {new Date(e.earnedAt).toLocaleDateString("zh-CN")}
                  </time>
                </div>
                <span className="xp-entry-amount">
                  {e.amount > 0 ? `+${e.amount}` : e.amount} XP
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无记录。</p>
        )}
      </div>

      <footer className="xp-footer">
        <p className="xp-asOf">数据更新于 {new Date(asOf).toLocaleString("zh-CN")}</p>
        <Link href="/" className="secondary">
          返回首页
        </Link>
      </footer>
    </section>
  );
}

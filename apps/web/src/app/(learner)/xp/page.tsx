"use client";

// 个人经验概览页：只显示后端真实返回的个人 XP 数据。
// 个人经验（daily-learning XP）不进入排行榜；排行榜仅用 Challenge Points（见 /leaderboard）。
// 禁用或不可用时显示诚实提示；不伪造等级、streak、CEFR。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getMeXp, type MeXp } from "@/lib/api";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; data: MeXp }
  | { phase: "empty" };

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
      setState({ phase: "empty" });
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
        <h1>个人经验</h1>
        <p role="status">正在加载…</p>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section className="xp-page">
        <h1>个人经验</h1>
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

  if (state.phase === "empty") {
    return (
      <section className="xp-page">
        <h1>个人经验</h1>
        <p>暂无个人经验记录。完成学习任务后，合格评价将在此显示。</p>
        <Link href="/" className="secondary">
          返回首页
        </Link>
      </section>
    );
  }

  const { totalXp, entries, asOf } = state.data;
  return (
    <section className="xp-page">
      <h1>个人经验</h1>
      <div className="xp-total">
        <span className="xp-total-label">累计个人经验</span>
        <strong className="xp-total-amount">{totalXp}</strong>
        <span className="xp-total-unit">XP</span>
      </div>
      <p className="xp-note">个人经验是每次合格评价获得的成长积分，不参与排行榜排名。</p>

      <div className="xp-latest">
        <h2>最近获得</h2>
        {entries.length > 0 ? (
          <ul className="xp-entries">
            {entries.slice(0, 5).map((e: MeXp["entries"][number], i: number) => (
              <li key={`${i}-${e.earnedAt}`}>
                <span className="xp-entry-amount">{e.amount > 0 ? `+${e.amount}` : e.amount}</span>
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
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无记录。</p>
        )}
      </div>

      <p className="xp-asOf">数据截至：{new Date(asOf).toLocaleString("zh-CN")}</p>
      <Link href="/" className="secondary">
        返回首页
      </Link>
    </section>
  );
}

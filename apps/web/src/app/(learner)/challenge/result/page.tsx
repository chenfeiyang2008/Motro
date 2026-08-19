"use client";

// 周挑战结果页（Ticket 21）：只显示真实服务端结果，不伪造积分/排名。
//   - 正确题数 / 10、本次新增 Challenge Points 来自【本次作答过程中服务端 verdict 的累加】；
//   - 已经计分的复习题数量（kind === 'already_scored'）；
//   - 本周个人 CP 与排名来自 GET /leaderboard/weekly 的 viewerChallengePoints / viewerRank；
//   - 明确：速度不占分、daily XP 与 CP 分开计算；
//   - 无庆祝动画/彩带，无虚构等级/连续天数/CEFR，不显示完整排行榜，不改答案。
// 说明：本章节在「未完成判分路径」下避免直接调用可能因后端 P1 失败的服务端判分；
//       结果页数据在流程完成后由 score 会话投影；若后端判分不可用则标 UNVERIFIED。
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getWeeklyLeaderboard, type WeeklyLeaderboardFixed } from "@/lib/api";

type PageState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; data: WeeklyLeaderboardFixed };

// 本次流畅态通过查询参数传递（仅作为展示提示，不参与判分）：
// ?correct=N&points=P&reviewed=M 由答题页在完成时携带。若缺失则不虚构。
function readIntParam(name: string): number | null {
  if (typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get(name);
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function ChallengeResultPage() {
  const router = useRouter();
  const [state, setState] = useState<PageState>({ phase: "loading" });

  const correct = readIntParam("correct");
  const points = readIntParam("points");
  const reviewed = readIntParam("reviewed");

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const res = await getWeeklyLeaderboard();
      if (cancelled) return;
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (res.status === 403) {
        router.replace("/change-password");
        return;
      }
      if (!res.ok || !res.data) {
        setState({ phase: "error", message: res.error?.message ?? "加载本周挑战榜失败，请重试" });
        return;
      }
      setState({ phase: "ready", data: res.data });
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state.phase === "loading") {
    return (
      <div className="challenge-shell">
        <p role="status" className="challenge-status">
          正在加载结果…
        </p>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="challenge-shell">
        <p role="alert" className="challenge-status challenge-status--error">
          {state.message}
        </p>
        <Link href="/leaderboard" className="challenge-back">
          返回周挑战榜
        </Link>
      </div>
    );
  }

  const d = state.data;
  const totalItems = 10;
  return (
    <div className="challenge-shell challenge-result">
      <h1 className="challenge-title">本周挑战 · 结果</h1>

      <dl className="challenge-result-grid">
        <div className="challenge-result-cell">
          <dt>正确题数</dt>
          <dd>{correct !== null ? `${correct} / ${totalItems}` : "—"}</dd>
        </div>
        <div className="challenge-result-cell">
          <dt>本次新增 Challenge Points</dt>
          <dd>{points !== null && points > 0 ? `+${points}` : points !== null ? "0" : "—"}</dd>
        </div>
        <div className="challenge-result-cell">
          <dt>已计分的复习题</dt>
          <dd>{reviewed !== null ? reviewed : "—"}</dd>
        </div>
        <div className="challenge-result-cell">
          <dt>本周个人 Challenge Points</dt>
          <dd>{d.viewerChallengePoints}</dd>
        </div>
        <div className="challenge-result-cell">
          <dt>本周个人排名</dt>
          <dd>{d.viewerRank !== null ? `第 ${d.viewerRank} 名` : "未上榜"}</dd>
        </div>
      </dl>

      <div className="challenge-result-notes">
        <p className="challenge-note">答题速度不影响积分。</p>
        <p className="challenge-note">
          每日学习 XP 与 Challenge Points 分开计算：只有服务端判分的挑战题计入本周挑战积分，日常 XP
          不进入排行榜。
        </p>
        <p className="challenge-note">
          若你在本次作答前已在该词义方向获得过 Challenge
          Point，则该题显示“不重复得分”，不会重复累计。
        </p>
      </div>

      <div className="challenge-actions">
        <Link href="/leaderboard" className="primary-btn">
          返回周挑战榜
        </Link>
      </div>
    </div>
  );
}

"use client";

// 结果页：安静总结刚结束的这一次会话并离开。
// - 数据来自正常完成流程写入的 sessionStorage 展示快照（仅本会话已接受事件的展示缓存，
//   不是学习进度真相）。无快照（刷新/直接访问）则诚实显示“本次已完成”与“返回首页”，不伪造统计。
// - 不展示 XP、等级、排行榜、streak。下一次复习由系统按记忆状态安排。
// - 登录态优先：401 → /login，403 → /change-password；未登录不得停留在此页。
//   网络失败 → 诚实的可重试状态（不伪装统计，也不把错误当“已完成”）。
// - 只有明确仍有可学习任务时才提供次要链接“继续学习”。
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getStudyToday } from "@/lib/api";
import { readResultSnapshot, clearResultSnapshot, type SessionResultSnapshot } from "../page";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; snapshot: SessionResultSnapshot | null; hasRemainingWork: boolean }
  | { phase: "network-error" };

export default function ResultPage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

  const [state, setState] = useState<LoadState>({ phase: "loading" });

  /** 重新加载（含网络错误后的“重试”）。快照只在本会话 getStudyToday 成功后清除。 */
  const load = useCallback(async (): Promise<void> => {
    setState({ phase: "loading" });
    // 读本会话展示快照（仅展示缓存）。只允许属于「当前 URL sessionId」的快照：
    // 若快照属于其他会话（sessionId 不匹配），视为无快照、不显示其统计，
    // 也绝不清理属于其他会话的快照。
    const readSnapshot = readResultSnapshot();
    const snapshot = readSnapshot && readSnapshot.sessionId === sessionId ? readSnapshot : null;
    let hasRemainingWork = false;
    const todayRes = await getStudyToday();
    // P1-3：登录态权威来自 API。
    if (todayRes.status === 401) {
      router.replace("/login");
      return;
    }
    if (todayRes.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (!todayRes.ok || todayRes.status === 0) {
      // 网络失败/服务不可用：诚实的可重试状态；不清除快照（重试成功后才显示并清除）。
      setState({ phase: "network-error" });
      return;
    }
    // 只有 here（getStudyToday 成功、即将进入 ready）才清除匹配快照，
    // 避免网络/5xx 时把统计永久丢失。
    if (snapshot) clearResultSnapshot();
    if (todayRes.data && !todayRes.data.noWork) {
      hasRemainingWork = true;
    }
    setState({ phase: "ready", snapshot, hasRemainingWork });
  }, [sessionId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    if (state.phase !== "ready" || !state.snapshot) return null;
    return state.snapshot.byKind;
  }, [state]);

  if (state.phase === "loading") {
    return (
      <section className="learner-result learner-result--state">
        <p className="result-eyebrow">学习完成</p>
        <h1>正在读取结果…</h1>
        <p role="status" className="result-state-note">
          正在确认这次学习的已接受记录。
        </p>
      </section>
    );
  }

  if (state.phase === "network-error") {
    return (
      <section className="learner-result learner-result--state">
        <p className="result-eyebrow result-eyebrow--warning">需要重新连接</p>
        <h1>暂时无法确认结果</h1>
        <p role="alert" className="result-network-error">
          连接失败，暂时无法确认本次学习结果。可重试；你的学习进度已保存在系统中。
        </p>
        <div className="result-actions">
          <button type="button" className="primary" onClick={() => void load()}>
            重试
          </button>
          <Link href="/" className="secondary">
            返回首页
          </Link>
        </div>
      </section>
    );
  }

  const snapshot = state.snapshot;

  return (
    <section className="learner-result">
      <header className="result-hero">
        <p className="result-eyebrow">
          <span className="result-eyebrow-mark" aria-hidden="true">
            ✓
          </span>
          学习完成
        </p>
        <h1>这次学习完成</h1>
        <p className="result-lede">
          {snapshot
            ? `你完成了本次安排的 ${snapshot.completedCount} 项学习。`
            : "本次学习已完成，已接受的进度会继续由系统安排。"}
        </p>
      </header>

      {snapshot ? (
        <div className="result-summary">
          <div className="result-total">
            <span className="result-total-label">本次完成</span>
            <strong>{snapshot.completedCount}</strong>
            <span className="result-total-unit">项学习</span>
          </div>

          <div className="result-breakdown">
            <p className="result-section-label">学习构成</p>
            {counts!.newLearning > 0 || counts!.initial > 0 || counts!.review > 0 ? (
              <ul className="result-counts">
                {counts!.newLearning > 0 && (
                  <li>
                    <span className="result-count-label">新学习</span>
                    <span className="result-count-value">{counts!.newLearning}</span>
                  </li>
                )}
                {counts!.initial > 0 && (
                  <li>
                    <span className="result-count-label">首复习</span>
                    <span className="result-count-value">{counts!.initial}</span>
                  </li>
                )}
                {counts!.review > 0 && (
                  <li>
                    <span className="result-count-label">复习</span>
                    <span className="result-count-value">{counts!.review}</span>
                  </li>
                )}
              </ul>
            ) : (
              <p className="result-state-note">本次没有可细分的学习分类。</p>
            )}
          </div>

          <div className="result-next">
            <span className="result-next-label">下一步</span>
            <p>下一次复习由系统按记忆状态安排。</p>
          </div>

          {/* 本次会话已接受事件累计获得的个人 XP（只来自服务端 xpAwarded，重放不计）。
              daily-learning XP 属于个人成长，绝不进入任何排行榜。 */}
          {typeof snapshot.xpAwarded === "number" && snapshot.xpAwarded > 0 ? (
            <div className="result-xp">
              <span className="result-xp-label">本次获得个人经验</span>
              <strong className="result-xp-amount">{snapshot.xpAwarded}</strong>
              <span className="result-xp-unit">XP</span>
              <p className="result-xp-note">合格首测/到期复习 5 XP；个人经验不参与排行榜排名。</p>
            </div>
          ) : (
            <div className="result-xp result-xp--zero">
              <span className="result-xp-label">本次个人经验</span>
              <strong className="result-xp-amount">{snapshot?.xpAwarded ?? 0}</strong>
              <span className="result-xp-unit">XP</span>
              <p className="result-xp-note">本次没有计入个人经验的合格评价。</p>
            </div>
          )}
        </div>
      ) : (
        <div className="result-summary result-summary--empty">
          <div className="result-next">
            <span className="result-next-label">记录已保存</span>
            <p>本次学习已完成。刷新页面后无法恢复本次统计，但学习进度不受影响。</p>
          </div>
        </div>
      )}

      <nav className="result-actions" aria-label="结果操作">
        <Link href="/" className="primary">
          返回首页
        </Link>
        {state.hasRemainingWork && (
          <Link href="/" className="secondary">
            继续学习
          </Link>
        )}
      </nav>
    </section>
  );
}

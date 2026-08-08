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
      <section className="learner-result">
        <p role="status">正在读取结果…</p>
      </section>
    );
  }

  if (state.phase === "network-error") {
    return (
      <section className="learner-result">
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
      <h1>这次学习完成</h1>

      {snapshot ? (
        <div className="result-panel">
          {snapshot.completedCount > 0 && (
            <p>
              本次完成了 <strong>{snapshot.completedCount}</strong> 项学习。
            </p>
          )}

          {(counts!.newLearning > 0 || counts!.initial > 0 || counts!.review > 0) && (
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
          )}

          <p className="result-next">下一次复习由系统按记忆状态安排。</p>
        </div>
      ) : (
        <div className="result-panel">
          <p className="result-next">
            本次学习已完成。刷新页面后无法恢复本次统计，但学习进度不受影响。
          </p>
        </div>
      )}

      <div className="result-actions">
        <Link href="/" className="primary">
          返回首页
        </Link>
        {state.hasRemainingWork && (
          <Link href="/" className="secondary">
            继续学习
          </Link>
        )}
      </div>
    </section>
  );
}

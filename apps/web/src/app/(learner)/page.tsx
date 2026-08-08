"use client";

// 学习者首页：回答“我今天该做什么”并开始/恢复学习。
// 数据全部来自服务端事实：/study/today（候选计数、hasActiveSession、noWork）、
// /study/progress（当前可学单元）、catalog（主课程名称）。不伪造 streak/XP/周进度。
// 唯一主操作“开始/继续学习”调用幂等 POST /study/sessions，成功后进入专注学习页。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  createOrResumeStudySession,
  getStudyProgress,
  getStudyToday,
  listCatalogCourses,
  type StudyProgress,
  type StudyToday,
} from "@/lib/api";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; code: string; message: string }
  | { phase: "ready"; today: StudyToday; progress: StudyProgress | null; courseTitle: string };

export default function LearnerHomePage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  async function load(): Promise<void> {
    setState({ phase: "loading" });
    const [todayRes, progressRes, catalogRes] = await Promise.all([
      getStudyToday(),
      getStudyProgress(),
      listCatalogCourses(),
    ]);
    if (todayRes.status === 401 || catalogRes.status === 401 || progressRes.status === 401) {
      router.replace("/login");
      return;
    }
    if (todayRes.status === 403 || catalogRes.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (!todayRes.ok || !todayRes.data) {
      if (todayRes.status === 404) {
        // 未设置主课程 / 没有可学课程：给出前往课程目录的唯一路径。
        setState({
          phase: "error",
          code: "no-primary-course",
          message: "尚未设置主课程",
        });
        return;
      }
      setState({
        phase: "error",
        code: "load",
        message: todayRes.error?.message ?? "加载失败，请稍后重试",
      });
      return;
    }
    const today = todayRes.data;
    const progress = progressRes.ok && progressRes.data ? progressRes.data : null;
    const courseTitle =
      catalogRes.ok && catalogRes.data
        ? (catalogRes.data.items.find((c) => c.isPrimary)?.title ?? "")
        : "";
    setState({ phase: "ready", today, progress, courseTitle });
  }

  useEffect(() => {
    void load();
  }, []);

  async function startOrResume(): Promise<void> {
    setBusy(true);
    setActionError("");
    const res = await createOrResumeStudySession();
    setBusy(false);
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (!res.ok || !res.data) {
      setActionError(res.error?.message ?? "开始学习失败，请稍后重试");
      return;
    }
    const data = res.data;
    if ("noWork" in data) {
      // 候选变化导致无任务：如实提示。
      setActionError("今天的计划已完成。");
      void load();
      return;
    }
    router.push(`/study/${data.sessionId}`);
  }

  const counts = state.phase === "ready" ? state.today.counts : null;

  return (
    <section className="learner-home">
      <h1>今天的学习</h1>
      <p className="home-sub">看看今天有哪些内容，然后专注完成这一次学习。</p>

      {state.phase === "loading" && (
        <div className="plan-panel">
          <p className="plan-note" role="status">
            加载今日计划…
          </p>
        </div>
      )}

      {state.phase === "error" && state.code === "load" && (
        <div className="plan-panel">
          <p role="alert">{state.message}</p>
          <div className="plan-actions">
            <button type="button" className="primary" onClick={() => void load()}>
              重试
            </button>
          </div>
        </div>
      )}

      {state.phase === "error" && state.code === "no-primary-course" && (
        <div className="plan-panel">
          <p>你还没有加入课程，先去课程目录选择一门课程作为主课程。</p>
          <div className="plan-actions">
            <Link href="/courses" className="primary">
              去课程
            </Link>
          </div>
        </div>
      )}

      {state.phase === "ready" && (
        <div className="plan-panel">
          <p className="plan-course">
            <strong>{state.courseTitle || "主课程"}</strong>
          </p>
          <p className="plan-course-meta">
            {courseUnitText(state.progress)} · 每日预算 {state.today.dailyBudgetMinutes} 分钟
          </p>

          {!state.today.noWork ? (
            <>
              <ul className="plan-counts">
                {counts!.dueCount > 0 && (
                  <li>
                    <span className="plan-count-label">到期复习</span>
                    <span className="plan-count-value">{counts!.dueCount}</span>
                  </li>
                )}
                {counts!.initialCount > 0 && (
                  <li>
                    <span className="plan-count-label">首次复习</span>
                    <span className="plan-count-value">{counts!.initialCount}</span>
                  </li>
                )}
                {counts!.newCount > 0 && (
                  <li>
                    <span className="plan-count-label">新学习</span>
                    <span className="plan-count-value">{counts!.newCount}</span>
                  </li>
                )}
              </ul>

              <div className="plan-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void startOrResume()}
                >
                  {busy ? "准备中…" : state.today.hasActiveSession ? "继续学习" : "开始学习"}
                </button>
                {state.today.hasActiveSession && (
                  <span className="plan-note">有一个进行中的会话等待继续。</span>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="plan-sticker">今天的计划已完成。</p>
              <div className="plan-actions">
                <Link href="/courses" className="primary">
                  浏览课程
                </Link>
              </div>
            </>
          )}

          {actionError !== "" && (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function courseUnitText(progress: StudyProgress | null): string {
  if (!progress) return "课程内容已就绪";
  const unlocked = progress.units.find((u) => u.position === progress.highestUnlockedUnit);
  if (!unlocked) return `可学习单元 ${progress.highestUnlockedUnit}`;
  return unlocked.title || `第 ${unlocked.position} 单元`;
}

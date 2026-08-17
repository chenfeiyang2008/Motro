"use client";

// 学习者仪表盘（工单 10）：回答“我今天该做什么” + 真实课程进度 + 进行中会话。
// 只消费当前已存在的 API：/study/today、/study/progress、/catalog/courses、/study/sessions/active。
// 不伪造 XP、排行榜、CEFR、streak、稳定词汇数字；课程进度只显示 API 真实返回的
// initialCompletedItemCount / stable 派生状态。未审核/草稿/provider payload 一律不展示。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  createOrResumeStudySession,
  getActiveStudySession,
  getStudyProgress,
  getStudyToday,
  listCatalogCourses,
  type StudyProgress,
  type StudySessionDetail,
  type StudyToday,
} from "@/lib/api";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; code: string; message: string }
  | { phase: "ready"; today: StudyToday; progress: StudyProgress | null; courseTitle: string };

export default function LearnerDashboardPage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [activeSession, setActiveSession] = useState<StudySessionDetail | null>(null);

  async function load(): Promise<void> {
    setState({ phase: "loading" });
    const [todayRes, progressRes, catalogRes, activeRes] = await Promise.all([
      getStudyToday(),
      getStudyProgress(),
      listCatalogCourses(),
      getActiveStudySession(),
    ]);
    if (
      todayRes.status === 401 ||
      catalogRes.status === 401 ||
      progressRes.status === 401 ||
      activeRes.status === 401
    ) {
      router.replace("/login");
      return;
    }
    if (todayRes.status === 403 || catalogRes.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (!todayRes.ok || !todayRes.data) {
      if (todayRes.status === 404) {
        setState({ phase: "error", code: "no-primary-course", message: "尚未设置主课程" });
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
    // active 会话是真实已存在的数据；404（无 active）是正常状态，不算错误。
    if (activeRes.ok && activeRes.data) setActiveSession(activeRes.data);
    else setActiveSession(null);
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
      setActionError("今天的计划已完成。");
      void load();
      return;
    }
    router.push(`/study/${data.sessionId}`);
  }

  const counts = state.phase === "ready" ? state.today.counts : null;

  return (
    <section className="learner-dashboard">
      <h1>学习仪表盘</h1>
      <p className="dash-sub">看看今天有哪些内容，然后在课程之间专注推进。</p>

      {state.phase === "loading" && (
        <div className="dash-panel">
          <p className="dash-status" role="status">
            加载仪表盘…
          </p>
        </div>
      )}

      {state.phase === "error" && state.code === "load" && (
        <div className="dash-panel">
          <p className="dash-error" role="alert">
            {state.message}
          </p>
          <div className="dash-actions">
            <button type="button" className="primary" onClick={() => void load()}>
              重试
            </button>
          </div>
        </div>
      )}

      {state.phase === "error" && state.code === "no-primary-course" && (
        <div className="dash-panel">
          <p className="dash-empty">你还没有加入课程，先去课程目录选择一门课程作为主课程。</p>
          <div className="dash-actions">
            <Link href="/courses" className="primary">
              去课程
            </Link>
          </div>
        </div>
      )}

      {state.phase === "ready" && (
        <>
          <div className="dash-grid">
            <div className="dash-panel dash-panel--primary glass-surface glass-surface--regular">
              <h3>今日学习</h3>
              <p className="dash-meta">
                {state.courseTitle || "主课程"} · 每日预算 {state.today.dailyBudgetMinutes} 分钟
              </p>
              {courseUnitText(state.progress)}

              {!state.today.noWork ? (
                <>
                  <ul className="dash-counts">
                    {counts!.dueCount > 0 && (
                      <li>
                        <span className="dash-count-label">到期复习</span>
                        <span className="dash-count-value">{counts!.dueCount}</span>
                      </li>
                    )}
                    {counts!.initialCount > 0 && (
                      <li>
                        <span className="dash-count-label">首次复习</span>
                        <span className="dash-count-value">{counts!.initialCount}</span>
                      </li>
                    )}
                    {counts!.newCount > 0 && (
                      <li>
                        <span className="dash-count-label">新学习</span>
                        <span className="dash-count-value">{counts!.newCount}</span>
                      </li>
                    )}
                  </ul>

                  <div className="dash-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => void startOrResume()}
                    >
                      {busy ? "准备中…" : state.today.hasActiveSession ? "继续学习" : "开始学习"}
                    </button>
                    {state.today.hasActiveSession && (
                      <span className="dash-session-note">有一个进行中的会话等待继续。</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="dash-sticker">今天的计划已完成。</p>
                  <div className="dash-actions">
                    <Link href="/courses" className="primary">
                      浏览课程
                    </Link>
                  </div>
                </>
              )}

              {actionError !== "" && (
                <p className="dash-error" role="alert">
                  {actionError}
                </p>
              )}
            </div>

            <div className="dash-panel">
              <h3>进行中的会话</h3>
              {activeSession ? (
                <>
                  <p className="dash-meta">
                    第 {activeSession.session.cursor} / {activeSession.session.itemCount} 项
                  </p>
                  <div className="dash-actions">
                    <Link href={`/study/${activeSession.session.sessionId}`} className="primary">
                      继续本次会话
                    </Link>
                  </div>
                </>
              ) : (
                <p className="dash-empty">当前没有进行中的会话。</p>
              )}
            </div>
          </div>

          <div className="dash-section">
            <h2>我的课程</h2>
            <CourseProgressList progress={state.progress} courseTitle={state.courseTitle} />
          </div>
        </>
      )}
    </section>
  );
}

function courseUnitText(progress: StudyProgress | null): React.ReactNode {
  if (!progress) return <span className="dash-meta">课程内容已就绪</span>;
  const unlocked = progress.units.find((u) => u.position === progress.highestUnlockedUnit);
  if (!unlocked)
    return <span className="dash-meta">可学习单元 {progress.highestUnlockedUnit}</span>;
  return <span className="dash-meta">{unlocked.title || `第 ${unlocked.position} 单元`}</span>;
}

/** 课程进度区：真实 API 返回的单元进度（首测完成/稳定派生），不伪造指标。 */
function CourseProgressList(props: { progress: StudyProgress | null; courseTitle: string }) {
  const { progress, courseTitle } = props;
  if (!progress) {
    return <p className="dash-empty">暂无主课程进度。</p>;
  }
  const units = progress.units;
  if (units.length === 0) {
    return <p className="dash-empty">主课程还没有可学习的单元。</p>;
  }
  const unlockedUnits = units.filter((u) => u.unlocked);
  const completedUnits = units.filter((u) => u.unlocked && u.initialCompletedItemCount > 0).length;
  return (
    // 单层、无嵌套的课程进度观测面：标题行与各单元作为兄弟行，共用一个边框源，
    // 避免“卡片包列表”产生重叠的 2px 分隔线（见 DESIGN「减少廉价横线」）。
    <div className="dash-course-list">
      <div className="dash-course-card">
        <Link href={`/courses/${progress.courseId}`} className="dash-course-link">
          <h3>{courseTitle || "主课程"}</h3>
          <p className="dash-course-meta">
            版本 {progress.releaseNumber} · 已解锁单元 {unlockedUnits.length} / {units.length}
          </p>
          <CourseProgressBar completedUnits={completedUnits} totalUnits={units.length} />
        </Link>
      </div>
      {units.map((unit) => (
        <div key={unit.position} className="dash-course-card">
          <div className="dash-course-link">
            <h3>
              {unit.position}. {unit.title}
            </h3>
            <p className="dash-course-meta">
              词项 {unit.itemCount} · 已完成首测 {unit.initialCompletedItemCount}
            </p>
            <p className="dash-course-progress">{unit.unlocked ? "已解锁" : "未解锁"}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function CourseProgressBar(props: { completedUnits: number; totalUnits: number }) {
  const pct =
    props.totalUnits > 0 ? Math.round((props.completedUnits / props.totalUnits) * 100) : 0;
  return (
    <div className="dash-course-progress">
      <div
        className="dash-progress-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`已完成 ${props.completedUnits} / ${props.totalUnits} 个单元`}
      >
        <div className="dash-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="dash-progress-text">
        已完成 {props.completedUnits} / {props.totalUnits} 个单元
      </p>
    </div>
  );
}

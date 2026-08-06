"use client";

// 学习者课程详情：当前 release 元数据与有序单元概要；
// 报名/主课程主操作：未加入时可“设为主课程”或“加入课程”，已加入可切换主课程，
// 已是主课程时显示非动作选中状态；切换确认与成功反馈说明保留历史。
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  enrollCourse,
  getCatalogCourse,
  setPrimaryCourse,
  type ApiResult,
  type CatalogCourseDetail,
} from "@/lib/api";

export default function CourseDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const courseId = typeof params.id === "string" ? params.id : "";
  const [course, setCourse] = useState<CatalogCourseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const res = await getCatalogCourse(courseId);
      if (cancelled) return;
      setLoading(false);
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (res.status === 403) {
        router.replace("/change-password");
        return;
      }
      if (!res.ok || !res.data) {
        setError(res.error?.message ?? "课程不存在或不可用");
        return;
      }
      setCourse(res.data);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [courseId, router]);

  /** 执行一次报名/主课程操作，成功后用返回的详情刷新页面状态并给出轻量反馈。 */
  async function act(
    call: () => Promise<ApiResult<CatalogCourseDetail>>,
    successText: string,
  ): Promise<void> {
    setBusy(true);
    setMessage(null);
    const res = await call();
    setBusy(false);
    if (!res.ok || !res.data) {
      setMessage({ tone: "error", text: res.error?.message ?? "操作失败，请重试" });
      return;
    }
    setCourse(res.data);
    setMessage({ tone: "success", text: successText });
  }

  function onJoinAsPrimary(): Promise<void> {
    return act(() => enrollCourse(courseId, true), "已设为主课程。其他课程及其学习历史不受影响。");
  }

  function onJoinOnly(): Promise<void> {
    return act(() => enrollCourse(courseId, false), "已加入课程。可以再将其设为主课程。");
  }

  function onSwitchPrimary(): Promise<void> {
    if (!course) return Promise.resolve();
    // 切换主课程是真正阻断流程的操作：确认时说明保留其他课程的学习历史。
    if (!window.confirm(`把主课程切换到「${course.title}」？其他课程及其学习历史不会被删除。`)) {
      return Promise.resolve();
    }
    return act(() => setPrimaryCourse(courseId), "已切换主课程。其他课程的学习历史不受影响。");
  }

  const isEnrolled = course?.isEnrolled ?? false;
  const isPrimary = course?.isPrimary ?? false;

  let actionArea: React.ReactNode = null;
  if (course && !isPrimary) {
    if (isEnrolled) {
      actionArea = (
        <div className="course-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void onSwitchPrimary()}
          >
            {busy ? "处理中…" : "设为主课程"}
          </button>
          <span className="course-badge">已加入</span>
        </div>
      );
    } else {
      actionArea = (
        <div className="course-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void onJoinAsPrimary()}
          >
            {busy ? "处理中…" : "设为主课程"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void onJoinOnly()}
          >
            加入课程
          </button>
        </div>
      );
    }
  }

  return (
    <section className="learner-courses">
      <p>
        <Link href="/courses">返回课程列表</Link>
      </p>
      {loading && <p>加载中…</p>}
      {!loading && error !== "" && (
        <p className="form-inline-message form-inline-error" role="alert">
          {error}
        </p>
      )}
      {course && (
        <>
          <h1>{course.title}</h1>
          <p className="course-meta">
            级别 {course.level.toUpperCase()} · 版本 {course.releaseNumber} · 未开始
            {course.isEnrolled && <span className="course-badge">已加入</span>}
            {course.isPrimary && <span className="course-badge course-badge-primary">主课程</span>}
          </p>
          {course.description ? <p>{course.description}</p> : null}

          {isPrimary && (
            <p className="course-primary-selected" role="status">
              已设为主课程
            </p>
          )}
          {!isPrimary && actionArea}
          {message && (
            <p
              className={`form-inline-message ${
                message.tone === "success" ? "form-inline-success" : "form-inline-error"
              }`}
              role={message.tone === "success" ? "status" : "alert"}
            >
              {message.text}
            </p>
          )}

          <h2>单元</h2>
          {course.units.length === 0 ? (
            <p>这门课程还没有单元。</p>
          ) : (
            <ol className="course-units">
              {course.units.map((unit) => (
                <li key={unit.unitId} className="course-unit">
                  <span className="course-unit-position">{unit.position}.</span>
                  <div>
                    <strong>{unit.title}</strong>
                    {unit.description ? <p className="course-desc">{unit.description}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

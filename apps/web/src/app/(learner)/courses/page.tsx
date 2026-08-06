"use client";

// 学习者课程列表：只读已发布课程（current release）。
// 未登录 401 → /login；加载失败/空目录显示可恢复状态。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { listCatalogCourses, type CatalogCourseSummary } from "@/lib/api";

export default function CoursesPage() {
  const router = useRouter();
  const [items, setItems] = useState<CatalogCourseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const res = await listCatalogCourses();
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
        setError(res.error?.message ?? "加载失败，请稍后重试");
        return;
      }
      setItems(res.data.items);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <section className="learner-courses">
      <h1>课程</h1>
      {loading && <p>加载中…</p>}
      {!loading && error !== "" && (
        <p className="form-inline-message form-inline-error" role="alert">
          {error}
        </p>
      )}
      {!loading && error === "" && items.length === 0 && <p>还没有可学习的课程。</p>}
      {!loading && items.length > 0 && (
        <ul className="course-list">
          {items.map((course) => (
            <li key={course.courseId} className="course-card">
              <Link href={`/courses/${course.courseId}`} className="course-card-link">
                <h2>{course.title}</h2>
                <p className="course-meta">
                  级别 {course.level.toUpperCase()} · 版本 {course.releaseNumber}
                </p>
                {course.description ? <p className="course-desc">{course.description}</p> : null}
                <p className="course-status">
                  {course.progressStatus === "not_started" ? "未开始" : course.progressStatus}
                  {course.isEnrolled && <span className="course-badge">已加入</span>}
                  {course.isPrimary && (
                    <span className="course-badge course-badge-primary">主课程</span>
                  )}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

"use client";

// 学习者课程详情：当前 release 的元数据与有序单元概要；阶段 4 显示“未开始”。
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getCatalogCourse, type CatalogCourseDetail } from "@/lib/api";

export default function CourseDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const courseId = typeof params.id === "string" ? params.id : "";
  const [course, setCourse] = useState<CatalogCourseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
          </p>
          {course.description ? <p>{course.description}</p> : null}

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

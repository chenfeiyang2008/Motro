"use client";

// 学习者课程列表：只读已发布课程（current release），keyset 游标分页。
// 首屏只加载第一页（默认 24 条），用户点击"加载更多"追加下一页。
// 未登录 401 → /login；加载失败/空目录显示可恢复状态。
//
// 失败恢复状态机：
//   - 首屏失败（error 非空）：全页错误态 + "重试加载课程"按钮。
//   - 加载更多失败（loadMoreError 非空）：已加载 items 持续显示 + 行内错误 + "重试加载更多"。
//   - 加载更多失败后重试：复用同一个 nextCursor（不请求首页、不清空 items、不重复追加）。
//   - 连续点击防重入（loadMoreInFlight ref）；按钮 loading/disabled 正确恢复。
//   - 末页无 hasMore 时隐藏所有加载入口。
// 无障碍：role="alert"；按钮 min-height 44px；focus-visible；prefers-reduced-motion 无动画依赖。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { listCatalogCourses, type CatalogCourseSummary } from "@/lib/api";

const PAGE_LIMIT = 24;

export default function CoursesPage() {
  const router = useRouter();
  const [items, setItems] = useState<CatalogCourseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [loadMoreError, setLoadMoreError] = useState("");
  const loadMoreInFlight = useRef(false);

  // 认证跳转：401 → /login，403 → /change-password。
  async function handleAuthRedirect(res: { status: number }): Promise<boolean> {
    if (res.status === 401) {
      router.replace("/login");
      return true;
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return true;
    }
    return false;
  }

  // ─── 首屏加载 ───
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const res = await listCatalogCourses({ limit: PAGE_LIMIT });
      if (cancelled) return;
      setLoading(false);
      if (await handleAuthRedirect(res)) return;
      if (!res.ok || !res.data) {
        setError(res.error?.message ?? "加载失败，请稍后重试");
        return;
      }
      setItems(res.data.items);
      setNextCursor(res.data.nextCursor);
      setHasMore(res.data.hasMore);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // ─── 加载更多（重试复用同一个 nextCursor） ───
  const loadMore = useCallback(async () => {
    if (loadMoreInFlight.current || !nextCursor) return;
    loadMoreInFlight.current = true;
    setLoadingMore(true);
    setLoadMoreError("");
    const res = await listCatalogCourses({ limit: PAGE_LIMIT, cursor: nextCursor });
    loadMoreInFlight.current = false;
    setLoadingMore(false);
    if (await handleAuthRedirect(res)) return;
    if (!res.ok || !res.data) {
      // 加载更多失败：保留 items，显示行内错误与重试入口，不清空 cursor。
      setLoadMoreError(res.error?.message ?? "加载失败，请稍后重试");
      return;
    }
    // 成功追加，不重复（服务端 keyset 保证无重叠）。
    setItems((prev) => [...prev, ...res.data!.items]);
    setNextCursor(res.data.nextCursor);
    setHasMore(res.data.hasMore);
  }, [nextCursor, router]);

  // ─── 首屏重试（重新请求首页） ───
  const retryFirstLoad = useCallback(async () => {
    setLoading(true);
    setError("");
    setLoadMoreError("");
    const res = await listCatalogCourses({ limit: PAGE_LIMIT });
    setLoading(false);
    if (await handleAuthRedirect(res)) return;
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "加载失败，请稍后重试");
      return;
    }
    setItems(res.data.items);
    setNextCursor(res.data.nextCursor);
    setHasMore(res.data.hasMore);
  }, [router]);

  const showEmpty = !loading && error === "" && items.length === 0 && !hasMore;

  return (
    <section className="learner-courses">
      <h1>课程</h1>

      {/* 首屏加载中 */}
      {loading && <p>加载中…</p>}

      {/* 首屏失败：全页错误 + 重试 */}
      {!loading && error !== "" && (
        <>
          <p className="form-inline-message form-inline-error" role="alert">
            {error}
          </p>
          <button type="button" className="course-load-more" onClick={() => void retryFirstLoad()}>
            重试加载课程
          </button>
        </>
      )}

      {/* 空列表 */}
      {!loading && error === "" && showEmpty && <p>还没有可学习的课程。</p>}

      {/* 有课程：列表 + 加载更多 + 加载更多行内错误/重试 */}
      {!loading && error === "" && items.length > 0 && (
        <>
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

          {/* 加载更多失败：行内错误 + 重试按钮（保留已有 items） */}
          {loadMoreError !== "" && (
            <p className="form-inline-message form-inline-error" role="alert">
              {loadMoreError}
            </p>
          )}

          {/* 末页后不显示任何加载/重试入口 */}
          {hasMore ? (
            loadMoreError !== "" ? (
              <button
                type="button"
                className="course-load-more"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "加载中…" : "重试加载更多"}
              </button>
            ) : (
              <button
                type="button"
                className="course-load-more"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "加载中…" : "加载更多"}
              </button>
            )
          ) : null}
        </>
      )}
    </section>
  );
}

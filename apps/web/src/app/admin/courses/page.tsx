"use client";

// 管理端课程页：主操作为“新建课程”，列表展示标题、级别、草稿版本与可见状态。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createCourse, listCourses, type CourseListItem } from "@/lib/api";
import "../admin-courses.css";

const COURSE_LEVELS = ["a1", "a2", "b1", "b2", "c1", "c2"] as const;
type CourseLevel = (typeof COURSE_LEVELS)[number];

export default function AdminCoursesPage() {
  const [items, setItems] = useState<CourseListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const requestIdRef = useRef(0);

  const [showForm, setShowForm] = useState(false);
  const slugRef = useRef<HTMLInputElement>(null);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState<CourseLevel>("a1");
  const [description, setDescription] = useState("");
  const [formMessage, setFormMessage] = useState("");
  const [formMessageKind, setFormMessageKind] = useState<"error" | "success">("error");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async ({
      cursor = null,
      append = false,
      q = query,
    }: { cursor?: string | null; append?: boolean; q?: string } = {}) => {
      const requestId = ++requestIdRef.current;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setLoadingMore(false);
        setItems([]);
        setNextCursor(null);
        setHasMore(false);
      }
      setListError("");
      const res = await listCourses({ limit: 50, cursor, q });
      if (requestId !== requestIdRef.current) return;
      setLoading(false);
      setLoadingMore(false);
      if (!res.ok || !res.data) {
        setListError(res.error?.message ?? "加载失败，请重试");
        return;
      }
      const data = res.data;
      setItems((previous) => {
        const incoming = append ? [...previous, ...data.items] : data.items;
        const seen = new Set<string>();
        return incoming.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      });
      setNextCursor(data.nextCursor);
      setHasMore(data.hasMore);
    },
    [query],
  );

  useEffect(() => {
    void load({ q: query });
  }, [load, query]);

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = searchInput.trim();
    if (nextQuery === query) {
      void load({ q: nextQuery });
      return;
    }
    setQuery(nextQuery);
  }

  function loadMore() {
    if (!nextCursor || loadingMore || loading) return;
    void load({ cursor: nextCursor, append: true, q: query });
  }

  /*
   * Keep the current search when a new course is created. The server remains
   * the source of truth, so the refreshed first page replaces local rows.
   */
  function reloadCurrentQuery() {
    void load({ q: query });
  }

  /*
   * The list request is intentionally explicit rather than per-keystroke:
   * large installations should not receive one request for every character.
   */
  function retryList() {
    void load({ q: query });
  }

  function openForm() {
    setShowForm(true);
    setFormMessage("");
    setFormMessageKind("error");
    setFieldErrors({});
    requestAnimationFrame(() => slugRef.current?.focus());
  }

  function resetForm() {
    setSlug("");
    setTitle("");
    setLevel("a1");
    setDescription("");
    setFormMessage("");
    setFieldErrors({});
    setShowForm(false);
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFormMessage("");
    setFieldErrors({});
    const res = await createCourse({ slug, title, level, description });
    setBusy(false);
    if (res.ok && res.data) {
      setFormMessageKind("success");
      setFormMessage(`已创建课程 ${res.data.title}`);
      resetForm();
      reloadCurrentQuery();
      return;
    }
    if (res.error?.fieldErrors && res.error.fieldErrors.length > 0) {
      const byPath: Record<string, string> = {};
      for (const f of res.error.fieldErrors) {
        if (f.path && !byPath[f.path]) byPath[f.path] = f.message ?? "输入不合法";
      }
      setFieldErrors(byPath);
    }
    setFormMessageKind("error");
    setFormMessage(res.error?.message ?? "创建失败，请重试");
  }

  return (
    <section className="admin-courses-page">
      <h1>课程</h1>

      <form className="admin-courses-search" onSubmit={submitSearch} role="search">
        <label htmlFor="admin-course-search">搜索课程</label>
        <input
          id="admin-course-search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="标题或 slug"
          type="search"
          autoComplete="off"
        />
        <button type="submit" className="secondary" disabled={loading}>
          搜索
        </button>
        {query !== "" && (
          <button
            type="button"
            className="admin-courses-clear"
            onClick={() => {
              setSearchInput("");
              setQuery("");
            }}
            disabled={loading}
          >
            清除
          </button>
        )}
      </form>

      {listError !== "" && (
        <div className="admin-courses-error" role="alert">
          <p className="form-inline-message form-inline-error">{listError}</p>
          <button type="button" className="secondary" onClick={retryList} disabled={loading}>
            {loading ? "重试中…" : "重试"}
          </button>
        </div>
      )}

      {showForm ? null : (
        <button type="button" className="primary" onClick={openForm}>
          新建课程
        </button>
      )}

      {showForm && (
        <form className="lexicon-form" onSubmit={submitCreate} noValidate>
          <h2>新建课程</h2>

          <label htmlFor="course-slug">slug</label>
          <div>
            <input
              id="course-slug"
              ref={slugRef}
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="例如 high-school-words"
              autoComplete="off"
              required
            />
            {fieldErrors.slug && (
              <p className="field-error" role="alert">
                {fieldErrors.slug}
              </p>
            )}
          </div>

          <label htmlFor="course-title">标题</label>
          <div>
            <input
              id="course-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
            {fieldErrors.title && (
              <p className="field-error" role="alert">
                {fieldErrors.title}
              </p>
            )}
          </div>

          <label htmlFor="course-level">级别</label>
          <select
            id="course-level"
            value={level}
            onChange={(e) => setLevel(e.target.value as CourseLevel)}
          >
            {COURSE_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
          {fieldErrors.level && (
            <p className="field-error" role="alert">
              {fieldErrors.level}
            </p>
          )}

          <label htmlFor="course-desc">描述（可选）</label>
          <textarea
            id="course-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
          {fieldErrors.description && (
            <p className="field-error" role="alert">
              {fieldErrors.description}
            </p>
          )}

          {formMessage !== "" && (
            <p
              className={`form-inline-message ${
                formMessageKind === "success" ? "form-inline-success" : "form-inline-error"
              }`}
              role="alert"
            >
              {formMessage}
            </p>
          )}

          <div className="form-actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "创建中…" : "创建课程"}
            </button>
            <button type="button" className="secondary" onClick={resetForm}>
              取消
            </button>
          </div>
        </form>
      )}

      {items.length === 0 && !loading && !listError ? (
        <p>{query ? "没有匹配的课程。" : "还没有课程。点击“新建课程”创建第一门课程。"}</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="lexicon-table">
            <caption>课程列表</caption>
            <thead>
              <tr>
                <th scope="col">标题</th>
                <th scope="col">slug</th>
                <th scope="col">级别</th>
                <th scope="col">草稿版本</th>
                <th scope="col">可见性</th>
              </tr>
            </thead>
            <tbody>
              {items.map((course) => (
                <tr key={course.id}>
                  <td>
                    <Link href={`/admin/courses/${course.id}/draft`}>{course.title}</Link>
                  </td>
                  <td>{course.slug}</td>
                  <td>
                    <span className="course-badge">{course.level.toUpperCase()}</span>
                  </td>
                  <td>{course.draftVersion ?? "—"}</td>
                  <td>{course.visibility}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loading && <p className="admin-courses-loading">加载中…</p>}
      {!loading && items.length > 0 && hasMore && (
        <div className="admin-courses-more">
          <button type="button" className="secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
      {!loading && items.length > 0 && !hasMore && (
        <p className="admin-courses-end">已显示全部{query ? "匹配的" : ""}课程</p>
      )}
    </section>
  );
}

"use client";

// 管理端课程页：主操作为“新建课程”，列表展示标题、级别、草稿版本与可见状态。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createCourse, listCourses, type CourseListItem } from "@/lib/api";

const COURSE_LEVELS = ["a1", "a2", "b1", "b2", "c1", "c2"] as const;
type CourseLevel = (typeof COURSE_LEVELS)[number];

export default function AdminCoursesPage() {
  const [items, setItems] = useState<CourseListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");

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

  const load = useCallback(async () => {
    setLoading(true);
    setListError("");
    const res = await listCourses();
    setLoading(false);
    if (!res.ok || !res.data) {
      setListError(res.error?.message ?? "加载失败，请重试");
      return;
    }
    setItems(res.data.items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      void load();
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
    <section>
      <h1>课程</h1>

      {listError !== "" && (
        <p className="form-inline-message form-inline-error" role="alert">
          {listError}
        </p>
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
        <p>还没有课程。点击“新建课程”创建第一门课程。</p>
      ) : (
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
      )}
      {loading && <p>加载中…</p>}
    </section>
  );
}

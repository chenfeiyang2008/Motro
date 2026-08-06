"use client";

// 课程草稿编排页：元数据编辑 + 单元大纲 + 保存草稿。
// 主操作为“保存草稿”；显示当前草稿版本与未保存状态；单元用上移/下移按钮排序（不依赖拖拽）。
// 课程词项区域暂时只显示空状态，不实现词项功能（工单 03）。
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  createCourseUnit,
  deleteCourseUnit,
  getCourseDraft,
  reorderCourseUnits,
  updateCourseDraft,
  updateCourseUnit,
  type CourseDraftDetail,
  type UnitDto,
} from "@/lib/api";

const COURSE_LEVELS = ["a1", "a2", "b1", "b2", "c1", "c2"] as const;
type CourseLevel = (typeof COURSE_LEVELS)[number];

export default function CourseDraftPage() {
  const params = useParams<{ id: string }>();
  const courseId = typeof params.id === "string" ? params.id : "";

  const [draft, setDraft] = useState<CourseDraftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // 元数据表单（用户可编辑副本）
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState<CourseLevel>("a1");
  const [description, setDescription] = useState("");
  const [dirty, setDirty] = useState(false);

  // 单元编辑状态
  const [addingUnit, setAddingUnit] = useState(false);
  const [newUnitTitle, setNewUnitTitle] = useState("");
  const [newUnitDesc, setNewUnitDesc] = useState("");
  const [editingUnitId, setEditingUnitId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"error" | "success">("error");
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const res = await getCourseDraft(courseId);
    setLoading(false);
    if (!res.ok || !res.data) {
      setLoadError(res.error?.message ?? "草稿加载失败");
      return;
    }
    applyDraft(res.data, true);
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 应用服务端草稿；syncMetadata 为 true 时同步元数据表单（初始加载/保存元数据后）。 */
  function applyDraft(next: CourseDraftDetail, syncMetadata: boolean): void {
    setDraft(next);
    setConflictVersion(null);
    if (syncMetadata) {
      setSlug(next.slug);
      setTitle(next.title);
      setLevel(next.level as CourseLevel);
      setDescription(next.description ?? "");
      setDirty(false);
    }
  }

  function markDirty(): void {
    setDirty(true);
    setMessage("");
  }

  async function saveMetadata(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setMessage("");
    const res = await updateCourseDraft(courseId, {
      slug,
      title,
      level,
      description,
      draftVersion: draft.version,
    });
    setBusy(false);
    if (res.ok && res.data) {
      applyDraft(res.data, true);
      setMessageKind("success");
      setMessage("草稿已保存");
      return;
    }
    if (res.status === 409 && res.error?.currentDraftVersion !== undefined) {
      setConflictVersion(res.error.currentDraftVersion);
      setMessageKind("error");
      setMessage("草稿已被其他修改更新，请重新加载后再保存");
      return;
    }
    setMessageKind("error");
    setMessage(res.error?.message ?? "保存失败，请重试");
  }

  async function addUnit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const unitId = crypto.randomUUID();
    setBusy(true);
    setMessage("");
    const res = await createCourseUnit(courseId, unitId, {
      title: newUnitTitle,
      description: newUnitDesc,
      draftVersion: draft.version,
    });
    setBusy(false);
    if (res.ok && res.data) {
      applyDraft(res.data, false);
      setNewUnitTitle("");
      setNewUnitDesc("");
      setAddingUnit(false);
      setMessageKind("success");
      setMessage("单元已添加");
      return;
    }
    handleConflict(res.status, res.error?.currentDraftVersion, res.error?.message);
  }

  async function saveUnit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !editingUnitId) return;
    setBusy(true);
    setMessage("");
    const res = await updateCourseUnit(courseId, editingUnitId, {
      title: editTitle,
      description: editDesc,
      draftVersion: draft.version,
    });
    setBusy(false);
    if (res.ok && res.data) {
      applyDraft(res.data, false);
      setEditingUnitId(null);
      setMessageKind("success");
      setMessage("单元已更新");
      return;
    }
    handleConflict(res.status, res.error?.currentDraftVersion, res.error?.message);
  }

  async function removeUnit(unit: UnitDto) {
    if (!draft) return;
    if (!window.confirm(`确认删除单元“${unit.title}”？`)) return;
    setBusy(true);
    setMessage("");
    const res = await deleteCourseUnit(courseId, unit.id, { draftVersion: draft.version });
    setBusy(false);
    if (res.ok && res.data) {
      applyDraft(res.data, false);
      if (editingUnitId === unit.id) setEditingUnitId(null);
      setMessageKind("success");
      setMessage("单元已删除");
      return;
    }
    handleConflict(res.status, res.error?.currentDraftVersion, res.error?.message);
  }

  async function moveUnit(unit: UnitDto, direction: "up" | "down") {
    if (!draft) return;
    const units = draft.units;
    const index = units.findIndex((u) => u.id === unit.id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= units.length) return;
    const next = [...units];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setBusy(true);
    setMessage("");
    const res = await reorderCourseUnits(courseId, {
      unitIds: next.map((u) => u.id),
      draftVersion: draft.version,
    });
    setBusy(false);
    if (res.ok && res.data) {
      applyDraft(res.data, false);
      setMessageKind("success");
      setMessage(direction === "up" ? "单元已上移" : "单元已下移");
      return;
    }
    handleConflict(res.status, res.error?.currentDraftVersion, res.error?.message);
  }

  function handleConflict(
    status: number,
    currentVersion: number | undefined,
    messageText: string | undefined,
  ): void {
    if (status === 409 && currentVersion !== undefined) {
      setConflictVersion(currentVersion);
      setMessageKind("error");
      setMessage("草稿已被其他修改更新，请重新加载后再操作");
      return;
    }
    setMessageKind("error");
    setMessage(messageText ?? "操作失败，请重试");
  }

  if (loading) return <p>加载中…</p>;
  if (loadError !== "" || !draft) {
    return (
      <section>
        <p>
          <Link href="/admin/courses">返回课程列表</Link>
        </p>
        <p className="form-inline-message form-inline-error" role="alert">
          {loadError || "课程草稿不存在"}
        </p>
      </section>
    );
  }

  return (
    <section>
      <p>
        <Link href="/admin/courses">返回课程列表</Link>
      </p>
      <h1>{draft.title}</h1>
      <p>
        当前草稿版本：{draft.version}
        {dirty && <span className="unsaved-indicator"> · 有未保存的修改</span>}
      </p>

      {conflictVersion !== null && (
        <p className="duplicate-warning" role="alert">
          草稿版本冲突：当前服务端版本为 {conflictVersion}，你的修改未保存。请重新加载后再编辑。
          <button type="button" className="secondary" onClick={() => void load()}>
            重新加载
          </button>
        </p>
      )}

      {message !== "" && (
        <p
          className={`form-inline-message ${
            messageKind === "success" ? "form-inline-success" : "form-inline-error"
          }`}
          role="alert"
        >
          {message}
        </p>
      )}

      <h2>课程元数据</h2>
      <form className="lexicon-form" onSubmit={saveMetadata} noValidate>
        <label htmlFor="draft-slug">slug</label>
        <input
          id="draft-slug"
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            markDirty();
          }}
        />
        <label htmlFor="draft-title">标题</label>
        <input
          id="draft-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            markDirty();
          }}
        />
        <label htmlFor="draft-level">级别</label>
        <select
          id="draft-level"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value as CourseLevel);
            markDirty();
          }}
        >
          {COURSE_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l.toUpperCase()}
            </option>
          ))}
        </select>
        <label htmlFor="draft-desc">描述（可选）</label>
        <textarea
          id="draft-desc"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            markDirty();
          }}
          rows={3}
        />
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "保存中…" : "保存草稿"}
          </button>
        </div>
      </form>

      <div className="section-heading">
        <h2>单元大纲</h2>
        {addingUnit ? null : (
          <button type="button" className="secondary" onClick={() => setAddingUnit(true)}>
            新增单元
          </button>
        )}
      </div>

      {addingUnit && (
        <form className="lexicon-form" onSubmit={addUnit} noValidate>
          <h3>新增单元</h3>
          <label htmlFor="new-unit-title">单元标题</label>
          <input
            id="new-unit-title"
            value={newUnitTitle}
            onChange={(e) => setNewUnitTitle(e.target.value)}
            required
          />
          <label htmlFor="new-unit-desc">描述（可选）</label>
          <textarea
            id="new-unit-desc"
            value={newUnitDesc}
            onChange={(e) => setNewUnitDesc(e.target.value)}
            rows={2}
          />
          <div className="form-actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "添加中…" : "添加单元"}
            </button>
            <button type="button" className="secondary" onClick={() => setAddingUnit(false)}>
              取消
            </button>
          </div>
        </form>
      )}

      {draft.units.length === 0 ? (
        <p>还没有单元。点击“新增单元”添加第一个单元。</p>
      ) : (
        <ol className="unit-list">
          {draft.units.map((unit, index) => (
            <li key={unit.id} className="unit-item">
              <div className="unit-main">
                <span className="unit-position">{index + 1}.</span>
                {editingUnitId === unit.id ? (
                  <form className="unit-edit-form" onSubmit={saveUnit} noValidate>
                    <label htmlFor={`edit-title-${unit.id}`}>标题</label>
                    <input
                      id={`edit-title-${unit.id}`}
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      required
                    />
                    <label htmlFor={`edit-desc-${unit.id}`}>描述（可选）</label>
                    <textarea
                      id={`edit-desc-${unit.id}`}
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      rows={2}
                    />
                    <div className="form-actions">
                      <button type="submit" className="primary" disabled={busy}>
                        保存单元
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setEditingUnitId(null)}
                      >
                        取消
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div>
                      <strong>{unit.title}</strong>
                      {unit.description ? <p>{unit.description}</p> : null}
                    </div>
                    <div className="unit-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={index === 0 || busy}
                        aria-label={`上移 ${unit.title}`}
                        onClick={() => void moveUnit(unit, "up")}
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={index === draft.units.length - 1 || busy}
                        aria-label={`下移 ${unit.title}`}
                        onClick={() => void moveUnit(unit, "down")}
                      >
                        下移
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setEditingUnitId(unit.id);
                          setEditTitle(unit.title);
                          setEditDesc(unit.description ?? "");
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="secondary danger"
                        disabled={busy}
                        onClick={() => void removeUnit(unit)}
                      >
                        删除
                      </button>
                    </div>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <h2>课程词项</h2>
      <p className="empty-hint">课程词项功能将在后续工单实现。当前课程还没有任何词项。</p>
    </section>
  );
}

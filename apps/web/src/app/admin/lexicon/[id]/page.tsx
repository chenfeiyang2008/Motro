"use client";

// 词条详情页：展示词条事实、来源（provenance）摘要与最近审计操作。
// Ticket 19：支持编辑词条元数据（PATCH）与 归档/激活；来源事实（revision/page identity、
// content hash）永远只读；被草稿引用时归档会 fail-closed 422。
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  activateLexicalEntry,
  archiveLexicalEntry,
  getLexicalEntry,
  updateLexicalEntry,
  type LexicalEntryDetail,
  type UpdateLexicalEntryPayload,
} from "@/lib/api";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

export default function LexicalEntryDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [entry, setEntry] = useState<LexicalEntryDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // 编辑状态
  const [showEdit, setShowEdit] = useState(false);
  const [editPos, setEditPos] = useState("");
  const [editPron, setEditPron] = useState("");
  const [editSenses, setEditSenses] = useState<{ meaning: string; example?: string }[]>([]);
  const [editSourceNote, setEditSourceNote] = useState("");
  const [editError, setEditError] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  // 归档/激活状态
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const id = typeof params.id === "string" ? params.id : "";
    const res = await getLexicalEntry(id);
    setLoading(false);
    if (res.status === 404) {
      router.replace("/admin/lexicon");
      return;
    }
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "词条不存在或加载失败");
      return;
    }
    setEntry(res.data);
  }, [params.id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  function openEdit(): void {
    if (!entry) return;
    setEditPos(entry.partOfSpeech ?? "");
    setEditPron(entry.pronunciation ?? "");
    setEditSenses(
      entry.senses.map((s) =>
        s.example ? { meaning: s.meaning, example: s.example } : { meaning: s.meaning },
      ),
    );
    setEditSourceNote("");
    setEditError("");
    setShowEdit(true);
  }

  async function onEditSave(): Promise<void> {
    if (!entry) return;
    const validSenses = editSenses
      .filter((s) => s.meaning.trim() !== "")
      .map((s) =>
        s.example && s.example.trim() !== ""
          ? { meaning: s.meaning.trim(), example: s.example.trim() }
          : { meaning: s.meaning.trim() },
      );
    const pos = editPos.trim();
    const pron = editPron.trim();
    const sourceNote = editSourceNote.trim();
    const payload: UpdateLexicalEntryPayload = { senses: validSenses };
    if (pos !== "") payload.partOfSpeech = pos;
    if (pron !== "") payload.pronunciation = pron;
    if (sourceNote !== "") payload.sourceNote = sourceNote;
    setEditBusy(true);
    setEditError("");
    const res = await updateLexicalEntry(entry.id, payload);
    setEditBusy(false);
    if (!res.ok) {
      setEditError(res.error?.message ?? "更新失败，请重试");
      return;
    }
    setShowEdit(false);
    void load();
  }

  async function onArchive(): Promise<void> {
    if (!entry) return;
    setStatusBusy(true);
    setStatusError("");
    const res = await archiveLexicalEntry(entry.id);
    setStatusBusy(false);
    if (!res.ok) {
      setStatusError(res.error?.message ?? "归档失败，请重试");
      return;
    }
    void load();
  }

  async function onActivate(): Promise<void> {
    if (!entry) return;
    setStatusBusy(true);
    setStatusError("");
    const res = await activateLexicalEntry(entry.id);
    setStatusBusy(false);
    if (!res.ok) {
      setStatusError(res.error?.message ?? "激活失败，请重试");
      return;
    }
    void load();
  }

  function updateSense(index: number, field: "meaning" | "example", value: string): void {
    setEditSenses((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  }

  return (
    <section>
      <p>
        <Link href="/admin/lexicon">返回词条列表</Link>
      </p>
      {loading ? (
        <p>加载中…</p>
      ) : error !== "" ? (
        <p className="form-inline-message form-inline-error" role="alert">
          {error}
        </p>
      ) : entry ? (
        <>
          <h1>{entry.canonicalSpelling}</h1>
          <p className="lexicon-readonly-note" role="note">
            可以编辑词条元数据；来源事实（revision/page identity、content
            hash）属于不可变记录，永远只读。
            {entry.status === "archived" && " 当前词条已归档，不能绑定到新课程。"}
          </p>

          <div className="lexicon-actions">
            <button type="button" className="primary" onClick={openEdit}>
              编辑词条
            </button>
            {entry.status === "archived" ? (
              <button
                type="button"
                className="secondary"
                disabled={statusBusy}
                onClick={() => void onActivate()}
              >
                {statusBusy ? "处理中…" : "激活"}
              </button>
            ) : (
              <button
                type="button"
                className="secondary danger"
                disabled={statusBusy}
                onClick={() => void onArchive()}
              >
                {statusBusy ? "处理中…" : "归档"}
              </button>
            )}
          </div>
          {statusError !== "" && (
            <p className="form-inline-message form-inline-error" role="alert">
              {statusError}
            </p>
          )}

          <h2>词条信息</h2>
          <dl>
            <div>
              <dt>规范化拼写</dt>
              <dd>{entry.normalizedSpelling}</dd>
            </div>
            <div>
              <dt>词性</dt>
              <dd>{entry.partOfSpeech ?? "—"}</dd>
            </div>
            <div>
              <dt>发音</dt>
              <dd>{entry.pronunciation ?? "—"}</dd>
            </div>
            <div>
              <dt>来源状态</dt>
              <dd>{entry.sourceStatus}</dd>
            </div>
            <div>
              <dt>引用次数</dt>
              <dd>{entry.referenceCount}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{entry.status}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{formatTime(entry.createdAt)}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{formatTime(entry.updatedAt)}</dd>
            </div>
          </dl>

          {showEdit && (
            <form
              className="lexicon-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void onEditSave();
              }}
            >
              <h2>编辑词条</h2>
              {editError !== "" && (
                <p className="form-inline-message form-inline-error" role="alert">
                  {editError}
                </p>
              )}
              <label htmlFor="edit-lex-pos">词性（可选）</label>
              <input
                id="edit-lex-pos"
                value={editPos}
                onChange={(e) => setEditPos(e.target.value)}
                placeholder="例如 noun"
              />
              <label htmlFor="edit-lex-pron">发音（可选）</label>
              <input
                id="edit-lex-pron"
                value={editPron}
                onChange={(e) => setEditPron(e.target.value)}
              />
              <h3>释义</h3>
              {editSenses.map((s, i) => (
                <div key={i} className="sense-row">
                  <label htmlFor={`edit-sense-${i}-meaning`}>释义 {i + 1}</label>
                  <input
                    id={`edit-sense-${i}-meaning`}
                    value={s.meaning}
                    onChange={(e) => updateSense(i, "meaning", e.target.value)}
                    placeholder="中文释义"
                  />
                  <label htmlFor={`edit-sense-${i}-example`}>例句 {i + 1}（可选）</label>
                  <input
                    id={`edit-sense-${i}-example`}
                    value={s.example ?? ""}
                    onChange={(e) => updateSense(i, "example", e.target.value)}
                  />
                </div>
              ))}
              <button
                type="button"
                className="secondary"
                onClick={() => setEditSenses((p) => [...p, { meaning: "", example: "" }])}
              >
                添加释义
              </button>
              <label htmlFor="edit-lex-source">来源说明（追加一条 manual 来源）</label>
              <textarea
                id="edit-lex-source"
                value={editSourceNote}
                onChange={(e) => setEditSourceNote(e.target.value)}
                rows={2}
              />
              <div className="form-actions">
                <button type="submit" className="primary" disabled={editBusy}>
                  {editBusy ? "保存中…" : "保存"}
                </button>
                <button type="button" className="secondary" onClick={() => setShowEdit(false)}>
                  取消
                </button>
              </div>
            </form>
          )}

          {entry.senses.length > 0 && (
            <>
              <h2>释义</h2>
              <ul>
                {entry.senses.map((sense, index) => (
                  <li key={index}>
                    {sense.meaning}
                    {sense.example ? `（例句：${sense.example}）` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2>来源</h2>
          {entry.provenance.length === 0 ? (
            <p>暂无来源记录。</p>
          ) : (
            <ul>
              {entry.provenance.map((p, index) => (
                <li key={index}>
                  {p.sourceType} · {p.sourceNote ?? "无说明"} · 创建者：
                  {p.createdByUsername ?? "未知"} · {formatTime(p.createdAt)}
                  {p.contentHash ? ` · 哈希 ${p.contentHash.slice(0, 12)}…` : ""}
                </li>
              ))}
            </ul>
          )}

          <h2>最近操作</h2>
          {entry.recentOperations.length === 0 ? (
            <p>暂无审计操作。</p>
          ) : (
            <ul>
              {entry.recentOperations.map((op, index) => (
                <li key={index}>
                  {op.action} · {formatTime(op.createdAt)}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

"use client";

// 管理端词条页：主操作为“新建词条”，列表可按拼写搜索，展示来源状态、引用次数与更新时间。
// 重复候选在表单附近提示（DUPLICATE_WARNING 提供继续/取消；完全相同冲突只读展示），不只用 toast。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLexicalEntry,
  listLexicalEntries,
  type CreateLexicalEntryPayload,
  type DuplicateCandidate,
  type LexicalEntrySummary,
} from "@/lib/api";

const PART_OF_SPEECH = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "pronoun",
  "preposition",
  "conjunction",
  "interjection",
  "determiner",
  "article",
  "numeral",
  "particle",
  "phrase",
  "abbreviation",
  "prefix",
  "suffix",
] as const;
type PosValue = (typeof PART_OF_SPEECH)[number];

interface SenseRow {
  meaning: string;
  example: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

export default function AdminLexiconPage() {
  const [items, setItems] = useState<LexicalEntrySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const spellingRef = useRef<HTMLInputElement>(null);
  const [spelling, setSpelling] = useState("");
  const [pos, setPos] = useState<PosValue | "">("");
  const [pronunciation, setPronunciation] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [senses, setSenses] = useState<SenseRow[]>([]);
  const [formMessage, setFormMessage] = useState("");
  const [formMessageKind, setFormMessageKind] = useState<"error" | "success">("error");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = useState<{
    candidates: DuplicateCandidate[];
    exact: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async (query: string, cursorValue: string | null) => {
    setLoading(true);
    setListError("");
    const res = await listLexicalEntries({ q: query, cursor: cursorValue });
    setLoading(false);
    if (!res.ok || !res.data) {
      setListError(res.error?.message ?? "加载失败，请重试");
      return;
    }
    if (cursorValue) {
      setItems((prev) => [...prev, ...res.data!.items]);
    } else {
      setItems(res.data.items);
    }
    setCursor(res.data.page.cursor);
    setHasMore(res.data.page.hasMore);
  }, []);

  useEffect(() => {
    void loadList("", null);
  }, [loadList]);

  function onSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadList(searchInput.trim(), null);
  }

  function openForm() {
    setShowForm(true);
    setFormMessage("");
    setFormMessageKind("error");
    setFieldErrors({});
    setDuplicate(null);
    requestAnimationFrame(() => spellingRef.current?.focus());
  }

  function resetForm() {
    setSpelling("");
    setPos("");
    setPronunciation("");
    setSourceNote("");
    setSenses([]);
    setFormMessage("");
    setFieldErrors({});
    setDuplicate(null);
    setShowForm(false);
  }

  async function submitCreate(confirmDuplicate: boolean) {
    setBusy(true);
    setFormMessage("");
    setFieldErrors({});
    const payload: CreateLexicalEntryPayload = {
      canonicalSpelling: spelling,
      confirmDuplicate,
    };
    if (pos !== "") payload.partOfSpeech = pos as PosValue;
    if (pronunciation.trim() !== "") payload.pronunciation = pronunciation.trim();
    const validSenses = senses
      .filter((s) => s.meaning.trim() !== "")
      .map((s) =>
        s.example.trim() !== ""
          ? { meaning: s.meaning.trim(), example: s.example.trim() }
          : { meaning: s.meaning.trim() },
      );
    if (validSenses.length > 0) payload.senses = validSenses;
    if (sourceNote.trim() !== "") payload.sourceNote = sourceNote.trim();

    const res = await createLexicalEntry(payload);
    setBusy(false);
    if (res.ok && res.data) {
      const created = res.data.canonicalSpelling;
      resetForm();
      // 创建成功后直接搜索该词条，让用户立刻看到刚创建的记录（列表分页不吞新词条）。
      setSearchInput(created);
      void loadList(created, null);
      return;
    }
    const code = res.error?.code;
    if (code === "DUPLICATE_WARNING" || code === "DUPLICATE_ENTRY") {
      // 重复候选在表单附近展示；消息由重复区块承载，不重复渲染 formMessage。
      setDuplicate({
        candidates: res.error?.duplicateCandidates ?? [],
        exact: code === "DUPLICATE_ENTRY",
      });
      setFormMessage("");
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

  function addSense() {
    setSenses((prev) => [...prev, { meaning: "", example: "" }]);
  }

  function updateSense(index: number, field: "meaning" | "example", value: string) {
    setSenses((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  }

  return (
    <section>
      <h1>词条</h1>

      <div className="lexicon-toolbar">
        <form onSubmit={onSearchSubmit} className="lexicon-toolbar">
          <label htmlFor="lexicon-search">搜索拼写</label>
          <input
            id="lexicon-search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="例如 abandon"
          />
          <button type="submit" className="secondary">
            搜索
          </button>
          {showForm ? null : (
            <button type="button" className="primary" onClick={openForm}>
              新建词条
            </button>
          )}
        </form>
      </div>

      {listError !== "" && (
        <p className="form-inline-message form-inline-error" role="alert">
          {listError}
        </p>
      )}

      {showForm && (
        <form
          className="lexicon-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCreate(false);
          }}
          noValidate
        >
          <h2>新建词条</h2>

          <label htmlFor="lex-spelling">拼写</label>
          <div>
            <input
              id="lex-spelling"
              ref={spellingRef}
              value={spelling}
              onChange={(e) => setSpelling(e.target.value)}
              autoComplete="off"
              required
            />
            {fieldErrors.canonicalSpelling && (
              <p className="field-error" role="alert">
                {fieldErrors.canonicalSpelling}
              </p>
            )}
          </div>

          <label htmlFor="lex-pos">词性（可选）</label>
          <select
            id="lex-pos"
            value={pos}
            onChange={(e) => setPos(e.target.value as PosValue | "")}
          >
            <option value="">未选择</option>
            {PART_OF_SPEECH.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {fieldErrors.partOfSpeech && (
            <p className="field-error" role="alert">
              {fieldErrors.partOfSpeech}
            </p>
          )}

          <label htmlFor="lex-pron">发音（可选）</label>
          <input
            id="lex-pron"
            value={pronunciation}
            onChange={(e) => setPronunciation(e.target.value)}
          />
          {fieldErrors.pronunciation && (
            <p className="field-error" role="alert">
              {fieldErrors.pronunciation}
            </p>
          )}

          <div className="form-actions">
            <h3>释义（可选）</h3>
            <button type="button" className="secondary" onClick={addSense}>
              添加释义
            </button>
          </div>
          {fieldErrors.senses && (
            <p className="field-error" role="alert">
              {fieldErrors.senses}
            </p>
          )}
          {senses.map((sense, index) => (
            <div key={index} className="sense-row">
              <label htmlFor={`sense-${index}-meaning`}>释义 {index + 1}</label>
              <input
                id={`sense-${index}-meaning`}
                value={sense.meaning}
                onChange={(e) => updateSense(index, "meaning", e.target.value)}
                placeholder="中文释义"
              />
              <label htmlFor={`sense-${index}-example`}>例句 {index + 1}（可选）</label>
              <input
                id={`sense-${index}-example`}
                value={sense.example}
                onChange={(e) => updateSense(index, "example", e.target.value)}
              />
            </div>
          ))}

          <label htmlFor="lex-source">来源说明（可选）</label>
          <textarea
            id="lex-source"
            value={sourceNote}
            onChange={(e) => setSourceNote(e.target.value)}
            rows={2}
          />
          {fieldErrors.sourceNote && (
            <p className="field-error" role="alert">
              {fieldErrors.sourceNote}
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

          {duplicate && (
            <div className="duplicate-warning" role="alert">
              <p>以下词条与本次输入规范化拼写相同或相似：</p>
              <ul>
                {duplicate.candidates.map((c) => (
                  <li key={c.id}>
                    <Link href={`/admin/lexicon/${c.id}`}>{c.canonicalSpelling}</Link>
                  </li>
                ))}
              </ul>
              {duplicate.exact ? (
                <p>完全相同词条已存在，不能继续创建。</p>
              ) : (
                <div className="form-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void submitCreate(true)}
                  >
                    继续创建
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setDuplicate(null);
                      setFormMessage("");
                    }}
                  >
                    取消创建
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="form-actions">
            {/* 重复阻断时只保留一个最强主操作：由重复提示的“继续创建”承担，隐藏保存。 */}
            {!duplicate && (
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "保存中…" : "保存词条"}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => {
                resetForm();
                setShowForm(false);
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {items.length === 0 && !loading && !listError ? (
        <p>还没有词条。点击“新建词条”创建第一个词条。</p>
      ) : (
        <table className="lexicon-table">
          <caption>词条列表</caption>
          <thead>
            <tr>
              <th scope="col">拼写</th>
              <th scope="col">来源</th>
              <th scope="col">引用次数</th>
              <th scope="col">更新时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link href={`/admin/lexicon/${item.id}`}>{item.canonicalSpelling}</Link>
                </td>
                <td>{item.sourceStatus}</td>
                <td>{item.referenceCount}</td>
                <td>{formatTime(item.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {hasMore && (
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => void loadList(searchInput.trim(), cursor)}
        >
          加载更多
        </button>
      )}
      {loading && <p>加载中…</p>}
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  createAdminMotivationBatch,
  createAdminMotivation,
  listAdminMotivation,
  updateAdminMotivation,
  type AdminMotivationCopy,
  type HomeMotivationCopy,
} from "@/lib/api";

const CATEGORY_LABEL: Record<HomeMotivationCopy["category"], string> = {
  poetry_pun: "诗句改编",
  english_joke: "英语冷笑话",
  learning_wit: "学习趣话",
  encouragement: "加油打气",
};

// Intentional plain-text safety guard; the server remains authoritative.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const EMPTY_FORM = {
  text: "",
  category: "poetry_pun" as HomeMotivationCopy["category"],
  attribution: "",
};

export default function AdminMotivationPage() {
  const [items, setItems] = useState<AdminMotivationCopy[]>([]);
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState<AdminMotivationCopy | null>(null);
  const [saving, setSaving] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchCategory, setBatchCategory] = useState<HomeMotivationCopy["category"]>("poetry_pun");
  const [batchAttribution, setBatchAttribution] = useState("");
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchError, setBatchError] = useState("");

  const batchRawLines = batchText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const batchLines = [...new Set(batchRawLines)];
  const batchIssues = batchRawLines.flatMap((line, index) => {
    if (line.length > 180) return [`第 ${index + 1} 行超过 180 个字符`];
    if (CONTROL_CHARS.test(line)) {
      return [`第 ${index + 1} 行包含不可用控制字符`];
    }
    if (/<[^>]*>|(?:https?:\/\/|www\.)\S+/i.test(line)) {
      return [`第 ${index + 1} 行不能包含 HTML 或链接`];
    }
    return [];
  });

  async function load(reset = true): Promise<void> {
    setLoading(true);
    setError("");
    const opts: { status?: string; category?: string; cursor?: string | null; limit?: number } = {
      limit: 30,
    };
    if (status) opts.status = status;
    if (category) opts.category = category;
    opts.cursor = reset ? null : cursor;
    const res = await listAdminMotivation(opts);
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "加载激励文案失败，请重试");
      return;
    }
    setItems(reset ? res.data.items : [...items, ...res.data.items]);
    setCursor(res.data.nextCursor ?? null);
    setHasMore(res.data.hasMore);
  }

  useEffect(() => {
    void load(true);
  }, [status, category]);

  async function save(): Promise<void> {
    if (!form.text.trim()) return setError("请填写文案");
    setSaving(true);
    setError("");
    const payload = {
      text: form.text,
      category: form.category,
      attribution: form.attribution || null,
    };
    const res = editing
      ? await updateAdminMotivation(editing.id, payload)
      : await createAdminMotivation(payload);
    setSaving(false);
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "保存失败，请重试");
      return;
    }
    setEditing(null);
    setForm(EMPTY_FORM);
    await load(true);
  }

  function beginEdit(item: AdminMotivationCopy): void {
    setEditing(item);
    setForm({ text: item.text, category: item.category, attribution: item.attribution ?? "" });
    setError("");
  }

  async function toggle(item: AdminMotivationCopy): Promise<void> {
    const res = await updateAdminMotivation(item.id, { isEnabled: !item.isEnabled });
    if (!res.ok) setError(res.error?.message ?? "更新状态失败，请重试");
    else await load(true);
  }

  return (
    <section className="admin-motivation">
      <div className="admin-page-header">
        <div>
          <h1>激励文案</h1>
          <p>管理学习首页每次进入时随机出现的一句短文案。</p>
        </div>
        <button type="button" className="secondary" onClick={() => void load(true)}>
          刷新
        </button>
      </div>

      <div className="admin-motivation-editor">
        <div className="admin-motivation-editor__heading">
          <h2>{editing ? "编辑文案" : "新增文案"}</h2>
          {editing && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setEditing(null);
                setForm(EMPTY_FORM);
              }}
            >
              取消编辑
            </button>
          )}
        </div>
        <label htmlFor="motivation-text">文案</label>
        <textarea
          id="motivation-text"
          value={form.text}
          maxLength={180}
          rows={2}
          onChange={(e) => setForm({ ...form, text: e.target.value })}
          placeholder="例如：日照香炉生紫烟，来学两个单词先。"
        />
        <div className="admin-motivation-editor__row">
          <label>
            分类
            <select
              value={form.category}
              onChange={(e) =>
                setForm({ ...form, category: e.target.value as HomeMotivationCopy["category"] })
              }
            >
              {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            出处（可选）
            <input
              value={form.attribution}
              maxLength={80}
              onChange={(e) => setForm({ ...form, attribution: e.target.value })}
              placeholder="例如：Motro 文案"
            />
          </label>
          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      <div className="admin-motivation-batch">
        <div className="admin-motivation-editor__heading">
          <div>
            <h2>批量添加</h2>
            <p>一行一句，最多 100 条；重复文案会自动跳过。</p>
          </div>
        </div>
        <>
          <textarea
            value={batchText}
            rows={6}
            maxLength={20000}
            onChange={(e) => setBatchText(e.target.value)}
            placeholder={"日照香炉生紫烟，来学两个单词先。\n今天学一点，明天就能多说一句。"}
          />
          <div className="admin-motivation-editor__row">
            <label>
              统一分类
              <select
                value={batchCategory}
                onChange={(e) => setBatchCategory(e.target.value as HomeMotivationCopy["category"])}
              >
                {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              统一出处（可选）
              <input
                value={batchAttribution}
                maxLength={80}
                onChange={(e) => setBatchAttribution(e.target.value)}
                placeholder="例如：Motro 文案"
              />
            </label>
            <button
              type="button"
              className="primary"
              disabled={batchSaving || batchLines.length === 0}
              onClick={() => {
                if (batchRawLines.length > 100) {
                  setBatchError("一次最多添加 100 条文案");
                  return;
                }
                if (batchIssues.length > 0) {
                  setBatchError(batchIssues[0] ?? "请修正文案后再提交");
                  return;
                }
                setBatchSaving(true);
                setBatchError("");
                void createAdminMotivationBatch({
                  items: batchLines.map((text) => ({
                    text,
                    category: batchCategory,
                    attribution: batchAttribution.trim() || null,
                  })),
                }).then(async (res) => {
                  setBatchSaving(false);
                  if (!res.ok || !res.data) {
                    setBatchError(res.error?.message ?? "批量添加失败，请重试");
                    return;
                  }
                  setBatchText("");
                  setBatchError(
                    res.data.skippedCount > 0
                      ? `已新增 ${res.data.createdCount} 条，跳过 ${res.data.skippedCount} 条重复文案`
                      : `已新增 ${res.data.createdCount} 条文案`,
                  );
                  await load(true);
                });
              }}
            >
              {batchSaving ? "添加中…" : `添加 ${batchLines.length || ""} 条`}
            </button>
          </div>
          <div className="admin-motivation-batch__meta">
            {batchRawLines.length > 0 && (
              <span>
                已识别 {batchLines.length} 条
                {batchRawLines.length !== batchLines.length ? "（已去重）" : ""}
              </span>
            )}
            {batchIssues.length > 0 && <span className="form-error">{batchIssues[0]}</span>}
          </div>
          {batchError && (
            <p className="form-error" role="alert">
              {batchError}
            </p>
          )}
        </>
      </div>

      <div className="admin-motivation-toolbar">
        <label>
          状态
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部</option>
            <option value="enabled">启用</option>
            <option value="disabled">停用</option>
          </select>
        </label>
        <label>
          分类
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">全部</option>
            {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading && items.length === 0 && <p role="status">正在加载激励文案…</p>}
      {!loading && !error && items.length === 0 && (
        <p className="admin-motivation-empty">还没有文案，先添加一句。</p>
      )}
      {items.length > 0 && (
        <div className="admin-motivation-table-wrap">
          <table className="admin-motivation-table">
            <thead>
              <tr>
                <th>文案</th>
                <th>分类</th>
                <th>出处</th>
                <th>状态</th>
                <th>更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="motivation-copy-cell">{item.text}</td>
                  <td>{CATEGORY_LABEL[item.category]}</td>
                  <td>{item.attribution ?? "—"}</td>
                  <td>
                    <span className={item.isEnabled ? "status-enabled" : "status-disabled"}>
                      {item.isEnabled ? "启用" : "停用"}
                    </span>
                  </td>
                  <td>{new Date(item.updatedAt).toLocaleString("zh-CN", { hour12: false })}</td>
                  <td>
                    <button type="button" className="text-button" onClick={() => beginEdit(item)}>
                      编辑
                    </button>
                    <button type="button" className="text-button" onClick={() => void toggle(item)}>
                      {item.isEnabled ? "停用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && hasMore && (
        <button type="button" className="secondary" onClick={() => void load(false)}>
          加载更多
        </button>
      )}
    </section>
  );
}

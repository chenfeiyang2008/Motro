"use client";

// 词条详情页：展示词条事实、来源（provenance）摘要与最近审计操作。刷新后仍可访问。
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getLexicalEntry, type LexicalEntryDetail } from "@/lib/api";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

export default function LexicalEntryDetailPage() {
  const params = useParams<{ id: string }>();
  const [entry, setEntry] = useState<LexicalEntryDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const id = typeof params.id === "string" ? params.id : "";
      const res = await getLexicalEntry(id);
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) {
        setError(res.error?.message ?? "词条不存在或加载失败");
        return;
      }
      setEntry(res.data);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

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

"use client";

// 管理端导入批次详情页（阶段 6 工单 01）：显示文件元数据、来源声明与状态。
// 唯一操作是「开始校验」占位按钮（本票不实现解析，后续工单启用）。
// 绝不回显磁盘路径、存储键、绝对路径或敏感元数据。
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getImportBatch, type ImportBatch } from "@/lib/api";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

function truncateHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
}

export default function AdminImportBatchDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const batchId = typeof params.id === "string" ? params.id : "";

  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "ready"; batch: ImportBatch }
  >({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      setState({ phase: "loading" });
      const res = await getImportBatch(batchId);
      if (cancelled) return;
      if (res.status === 401) {
        router.replace("/login");
        return;
      }
      if (res.status === 403) {
        router.replace("/change-password");
        return;
      }
      if (res.status === 404) {
        router.replace("/admin/imports");
        return;
      }
      if (!res.ok || !res.data) {
        setState({ phase: "error", message: res.error?.message ?? "加载失败，请重试" });
        return;
      }
      setState({ phase: "ready", batch: res.data });
    }
    if (batchId) void load();
    return () => {
      cancelled = true;
    };
  }, [batchId, router]);

  if (state.phase === "loading") {
    return (
      <section className="admin-imports">
        <p role="status">正在加载批次…</p>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section className="admin-imports">
        <h1>导入批次</h1>
        <p role="alert">{state.message}</p>
        <div className="import-actions">
          <Link href="/admin/imports" className="secondary">
            返回导入列表
          </Link>
        </div>
      </section>
    );
  }

  const b = state.batch;

  return (
    <section className="admin-imports">
      <h1>导入批次</h1>
      <div className="import-detail-panel">
        <h2>文件</h2>
        <dl className="import-detail-list">
          <div className="import-detail-row">
            <dt>文件名</dt>
            <dd>{b.file.originalFilename}</dd>
          </div>
          <div className="import-detail-row">
            <dt>格式</dt>
            <dd>{b.format}</dd>
          </div>
          <div className="import-detail-row">
            <dt>大小</dt>
            <dd>{formatBytes(b.file.byteSize)}</dd>
          </div>
          <div className="import-detail-row">
            <dt>MIME（嗅探）</dt>
            <dd>{b.file.sniffedMime}</dd>
          </div>
          <div className="import-detail-row">
            <dt>SHA-256</dt>
            <dd className="import-hash-cell" title={b.file.sha256Hex}>
              {truncateHash(b.file.sha256Hex)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="import-detail-panel">
        <h2>批次</h2>
        <dl className="import-detail-list">
          <div className="import-detail-row">
            <dt>状态</dt>
            <dd>{b.status}</dd>
          </div>
          <div className="import-detail-row">
            <dt>来源声明</dt>
            <dd>{b.sourceDeclaration}</dd>
          </div>
          <div className="import-detail-row">
            <dt>版本</dt>
            <dd>{b.version}</dd>
          </div>
          <div className="import-detail-row">
            <dt>创建时间</dt>
            <dd>{formatTime(b.createdAt)}</dd>
          </div>
          {b.updatedAt && (
            <div className="import-detail-row">
              <dt>更新时间</dt>
              <dd>{formatTime(b.updatedAt)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="import-actions">
        <button type="button" className="primary" disabled title="“开始校验”将在后续工单提供">
          开始校验（后续工单）
        </button>
        <Link href="/admin/imports" className="secondary">
          返回导入列表
        </Link>
      </div>
      <p className="import-placeholder-note">
        下一步"开始校验"将解析文件内容并逐行校验，在后续工单中启用。
      </p>
    </section>
  );
}

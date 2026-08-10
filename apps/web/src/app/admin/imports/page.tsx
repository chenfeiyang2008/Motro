"use client";

// 管理端导入页（阶段 6 工单 01）：本票唯一主操作是「上传文件并创建批次」。
// 只显示文件元数据、来源声明与状态；不实现解析/校验/提交（"开始校验"为后续占位）。
// 文件原名仅作元数据展示；绝不回显磁盘路径或存储键。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { listImportBatches, uploadImportBatch, type ImportBatch } from "@/lib/api";

// 当前仅接受 txt / csv / json；XLSX 在工单 02 启用。
const ALLOWED_FORMAT_HINT = ".txt / .csv / .json";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

export default function AdminImportsPage() {
  const [items, setItems] = useState<ImportBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  // 上传表单状态。
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [sourceDeclaration, setSourceDeclaration] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [retryableError, setRetryableError] = useState(false);
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  // P1-6：上传意图级幂等键。首次提交一个意图时生成；网络/服务端可重试错误重试时复用同一键；
  // 成功或不可重试错误或用户更换 File 对象/来源后清空，下次提交生成新键。
  const intentKeyRef = useRef<string | null>(null);
  // 当前意图对应的表单（真实 File 对象 + 来源）。更换 File 对象（即使同名）→ 新意图。
  const intentFormRef = useRef<{ file: File; source: string } | null>(null);

  function generateIntentKey(): string {
    return (
      globalThis.crypto?.randomUUID?.().toString() ??
      `imp-${Math.random().toString(36).slice(2)}-${Date.now()}`
    );
  }

  const loadList = useCallback(async () => {
    setLoading(true);
    setListError("");
    const res = await listImportBatches();
    setLoading(false);
    if (!res.ok || !res.data) {
      setListError(res.error?.message ?? "加载批次失败，请重试");
      return;
    }
    setItems(res.data.items);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function onUpload(): Promise<void> {
    const input = fileRef.current;
    const file = input?.files?.[0];
    if (!file) {
      setUploadError("请先选择一个原始文件");
      return;
    }
    const source = sourceDeclaration.trim();
    const prior = intentFormRef.current;
    // 输入变化（新的 File 对象或新来源）→ 视为新意图，生成新 key。
    // 用 File 对象引用比较：同名但内容不同的新 File（重新选择）也会生成新 key。
    if (!prior || prior.file !== file || prior.source !== source) {
      intentKeyRef.current = generateIntentKey();
      intentFormRef.current = { file, source };
      setRetryableError(false);
    }
    const key = intentKeyRef.current!;

    setUploading(true);
    setUploadError("");
    setUploadedId(null);
    const res = await uploadImportBatch({ file, sourceDeclaration: source, idempotencyKey: key });
    setUploading(false);
    if (!res.ok || !res.data) {
      // 网络失败（status 0）或服务端 retryable:true → 可重试：保留意图 key，
      // 用户点“重新上传”复用同一 key；明确不可重试错误 → 该意图终止，改输入后生成新 key。
      const retryable = res.status === 0 || res.error?.retryable === true;
      if (!retryable) {
        intentKeyRef.current = null;
        intentFormRef.current = null;
      }
      setRetryableError(retryable);
      setUploadError(
        res.error?.message ?? (retryable ? "网络连接失败，请点击重新上传重试" : "上传失败，请重试"),
      );
      return;
    }
    setUploadedId(res.data.id);
    // 成功：清理意图，下次是新的上传。
    intentKeyRef.current = null;
    intentFormRef.current = null;
    setRetryableError(false);
    setFileName("");
    setSourceDeclaration("");
    if (fileRef.current) fileRef.current.value = "";
    void loadList();
  }

  return (
    <section className="admin-imports">
      <h1>导入</h1>
      <p className="import-intro">
        上传一个原始词表文件，系统会保存文件元数据并创建一个可追溯的导入批次。本阶段不做文件内容解析。
      </p>

      {uploadError !== "" && (
        <p className="form-error" role="alert">
          {uploadError}
        </p>
      )}
      {uploadedId !== null && (
        <p className="form-success" role="status">
          上传成功，已创建批次。
        </p>
      )}

      <div className="import-upload-panel">
        <h2>上传原始文件</h2>
        <div className="import-field">
          <label htmlFor="import-file">文件（{ALLOWED_FORMAT_HINT}）</label>
          <input
            id="import-file"
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.json"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
          />
          {fileName !== "" && (
            <p className="import-file-name">
              已选择：<strong>{fileName}</strong>
            </p>
          )}
        </div>
        <div className="import-field">
          <label htmlFor="import-source">来源声明</label>
          <textarea
            id="import-source"
            value={sourceDeclaration}
            onChange={(e) => setSourceDeclaration(e.target.value)}
            rows={3}
            placeholder="例如：牛津 3000 高中阶段词表（XX 出版社，2026 版）"
          />
        </div>
        <div className="import-actions">
          <button
            type="button"
            className="primary"
            disabled={uploading}
            onClick={() => void onUpload()}
          >
            {uploading ? "上传中…" : retryableError ? "重新上传" : "上传并创建批次"}
          </button>
        </div>
        {retryableError && (
          <p className="import-retry-hint">
            网络中断或响应丢失。点击“重新上传”会复用同一次上传意图（同一
            Idempotency-Key），不会重复创建批次。
          </p>
        )}
        {/* 后续工单占位：不在本票偷偷实现解析/校验。 */}
        <p className="import-placeholder-note">“开始校验”将在后续工单提供。</p>
      </div>

      <div className="import-list-panel">
        <h2>批次</h2>
        {loading && <p role="status">正在加载批次…</p>}
        {!loading && listError !== "" && (
          <p role="alert">
            {listError}
            <button type="button" className="secondary" onClick={() => void loadList()}>
              重试
            </button>
          </p>
        )}
        {!loading && listError === "" && items.length === 0 && (
          <p className="import-empty">还没有批次。上传一个文件创建第一个批次。</p>
        )}
        {!loading && items.length > 0 && (
          <div className="import-table-wrap">
            <table className="import-table">
              <thead>
                <tr>
                  <th>原文件名</th>
                  <th>格式</th>
                  <th>大小</th>
                  <th>来源声明</th>
                  <th>状态</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link href={`/admin/imports/${b.id}`} className="import-link">
                        {b.file.originalFilename}
                      </Link>
                    </td>
                    <td>{b.format}</td>
                    <td>{formatBytes(b.file.byteSize)}</td>
                    <td className="import-source-cell">{b.sourceDeclaration}</td>
                    <td>{b.status}</td>
                    <td>{formatTime(b.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

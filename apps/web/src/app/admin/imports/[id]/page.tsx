"use client";

// 管理端导入批次详情页（阶段 6 工单 02）：
// 唯一任务是「确认映射并校验这个批次」。
// 三个状态分支：needs_mapping（含 uploaded/not_validated）、validated、validating/failed/stale。
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getImportBatch,
  updateImportMapping,
  validateImportBatch,
  listImportRows,
  type ImportBatch,
  type ImportDiscoveredOption,
  type ImportMapping,
  type ImportRow,
  type ImportSheetFieldSet,
} from "@/lib/api";

// ---- helpers ----

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

const STATUS_LABEL: Record<string, string> = {
  not_validated: "待校验",
  validating: "校验中",
  validated: "已校验",
  failed: "校验失败",
  uploaded: "已上传",
  needs_mapping: "待映射",
  stale: "映射已变更",
  committed: "已提交",
};

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

// ---- sub-components ----

function MappingForm({ batch, onSuccess }: { batch: ImportBatch; onSuccess: () => void }) {
  const [sheet, setSheet] = useState(batch.mapping?.sheet ?? "");
  const [spellingField, setSpellingField] = useState(batch.mapping?.spellingField ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const needsSheet = batch.format === "xlsx";
  const sheets: ImportDiscoveredOption[] =
    ((batch as Record<string, unknown>).sheets as ImportDiscoveredOption[]) ?? [];
  const fields: ImportDiscoveredOption[] =
    ((batch as Record<string, unknown>).fields as ImportDiscoveredOption[]) ?? [];
  const sheetFields =
    ((batch as Record<string, unknown>).sheetFields as
      Record<string, ImportSheetFieldSet> | undefined) ?? undefined;
  // 当前选定工作表对应的字段集：sheetFields[选中的 sheet]，回退到批次第一张表的 fields。
  // 这让两张表字段不同时，切换工作表后字段下拉随之更新（P1-D）。
  const selectedSheetFields =
    needsSheet && sheet && sheetFields?.[sheet] ? sheetFields[sheet] : undefined;
  const effectiveFields: ImportDiscoveredOption[] = selectedSheetFields
    ? selectedSheetFields.fieldIds.map((fieldId, i) => ({
        fieldId,
        label:
          selectedSheetFields.labels[i]?.trim() !== ""
            ? selectedSheetFields.labels[i]!
            : `列 ${i + 1}`,
      }))
    : fields;
  // JSON 字符串数组（无可用字段）视为固定提取：每个字符串是一个英文词条候选，
  // 无需字段选择器。对象数组（有可用字段）仍需确认英文拼写字段。
  const isJsonStringArray = batch.format === "json" && fields.length === 0;
  const needsField = batch.format !== "txt" && !isJsonStringArray;

  // 切换工作表时，若旧选中字段不在新工作表字段集中，清空字段选择以便重新确认。
  function onSheetChange(next: string): void {
    setSheet(next);
    const nextFields = next && sheetFields?.[next] ? sheetFields[next].fieldIds : [];
    if (nextFields.length > 0 && !nextFields.includes(spellingField)) setSpellingField("");
    if (next === "") setSpellingField("");
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError("");
    const mapping: ImportMapping = {};
    if (needsSheet) mapping.sheet = sheet;
    if (needsField) mapping.spellingField = spellingField;
    const res = await updateImportMapping(batch.id, mapping, batch.version);
    setSaving(false);
    if (!res.ok) {
      setError(res.error?.message ?? "保存失败");
      return;
    }
    onSuccess();
  }

  return (
    <div className="import-panel">
      <h2>映射</h2>
      {batch.format === "txt" && (
        <p className="import-note">TXT 格式：每行一个词，无需字段映射。</p>
      )}
      {isJsonStringArray && (
        <p className="import-note">
          JSON 字符串数组：每个字符串会作为一个英文词条候选，无需字段映射。
        </p>
      )}
      {needsSheet && sheets.length > 0 && (
        <div className="import-field">
          <label htmlFor="import-sheet">工作表</label>
          <select id="import-sheet" value={sheet} onChange={(e) => onSheetChange(e.target.value)}>
            <option value="">选择工作表…</option>
            {sheets.map((s) => (
              <option key={s.fieldId} value={s.fieldId}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {needsField && effectiveFields.length > 0 && (
        <div className="import-field">
          <label htmlFor="import-spelling-field">英文拼写字段</label>
          <select
            id="import-spelling-field"
            value={spellingField}
            onChange={(e) => setSpellingField(e.target.value)}
          >
            <option value="">选择字段…</option>
            {effectiveFields.map((f) => (
              <option key={f.fieldId} value={f.fieldId}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="import-actions">
        <button
          type="button"
          className="primary"
          disabled={saving || (needsField && !spellingField)}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "保存映射"}
        </button>
      </div>
    </div>
  );
}

function RowTable({
  rows,
  loading,
  nextCursor,
  hasMore,
  onLoadMore,
}: {
  rows: ImportRow[];
  loading: boolean;
  nextCursor: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  if (rows.length === 0 && !loading) return <p className="import-empty">暂无行数据。</p>;
  return (
    <div className="import-panel">
      <h2>行结果</h2>
      <div className="import-table-wrap">
        <table className="import-table import-row-table">
          <thead>
            <tr>
              <th className="import-row-th-ordinal">#</th>
              <th>原始值</th>
              <th>规范化</th>
              <th>状态</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="import-row-ordinal">{r.ordinal}</td>
                <td className="import-row-raw">{r.rawSummary}</td>
                <td className="import-row-normalized">{r.normalizedSpelling ?? "—"}</td>
                <td>
                  <span className={`import-status import-status-${r.status}`}>
                    {statusLabel(r.status)}
                  </span>
                </td>
                <td className="import-row-errors">
                  {r.errors.length > 0 ? r.errors.join(", ") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <p role="status">正在加载…</p>}
      {!loading && hasMore && (
        <div className="import-actions">
          <button type="button" className="secondary" onClick={onLoadMore}>
            加载更多
          </button>
        </div>
      )}
      {!loading && nextCursor === null && rows.length > 0 && (
        <p className="import-pagination-end">已加载全部行。</p>
      )}
    </div>
  );
}

// ---- page ----

export default function AdminImportBatchDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const batchId = typeof params.id === "string" ? params.id : "";
  const validateKeyRef = useRef<string | null>(null);

  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "ready"; batch: ImportBatch }
  >({ phase: "loading" });

  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState("");

  // Rows state.
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [rowsCursor, setRowsCursor] = useState<string | null>(null);
  const [rowsHasMore, setRowsHasMore] = useState(false);
  const [rowsLoading, setRowsLoading] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    const res = await getImportBatch(batchId);
    if (res.ok && res.data) {
      setState({ phase: "ready", batch: res.data });
      // Reset rows when batch reloads.
      setRows([]);
      setRowsCursor(null);
      setRowsHasMore(false);
    } else {
      setState({ phase: "error", message: res.error?.message ?? "加载失败" });
    }
  }, [batchId]);

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

  async function onValidate(): Promise<void> {
    if (!validateKeyRef.current) {
      validateKeyRef.current =
        globalThis.crypto?.randomUUID?.().toString() ?? `val-${Date.now()}-${Math.random()}`;
    }
    setValidating(true);
    setValidateError("");
    const res = await validateImportBatch(batchId, validateKeyRef.current);
    setValidating(false);
    if (!res.ok) {
      setValidateError(res.error?.message ?? "校验失败");
      if (res.status !== 409) validateKeyRef.current = null;
      return;
    }
    // 成功：刷新批次 + 重置幂等键。
    validateKeyRef.current = null;
    await reload();
  }

  async function loadMoreRows(): Promise<void> {
    setRowsLoading(true);
    const res = await listImportRows(batchId, rowsCursor, 50);
    setRowsLoading(false);
    if (!res.ok || !res.data) return;
    setRows((prev) => [...prev, ...res.data!.items]);
    setRowsCursor(res.data.nextCursor ?? null);
    setRowsHasMore(res.data.hasMore);
  }

  // Auto-load rows on first validated state.
  const currentValidationStatus =
    state.phase === "ready" ? state.batch.validationStatus : undefined;
  useEffect(() => {
    if (currentValidationStatus === "validated" && rows.length === 0) {
      void loadMoreRows();
    }
  }, [currentValidationStatus, rows.length]);

  // ---- render ----

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
  const isStale = b.isStale;
  const needsMapping = b.validationStatus === "not_validated";
  const isValidated = b.validationStatus === "validated" && !isStale;
  const isMappingRequired = b.format !== "txt";
  // JSON 字符串数组（无可用字段）视为固定提取：每个字符串是一个英文词条候选，
  // 无需字段选择器，校验主操作在无映射要求时即可用（P1-4）。
  const isJsonStringArray =
    b.format === "json" &&
    ((b as Record<string, unknown>).fields as { fieldId: string }[] | undefined)?.length === 0;
  const needsField = b.format !== "txt" && !isJsonStringArray;

  return (
    <section className="admin-imports">
      <h1>导入批次</h1>

      {/* File & batch info */}
      <div className="import-panel">
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
            <dt>来源声明</dt>
            <dd>{b.sourceDeclaration}</dd>
          </div>
          <div className="import-detail-row">
            <dt>校验状态</dt>
            <dd>
              <span className={`import-status import-status-${b.validationStatus}`}>
                {statusLabel(b.validationStatus)}
              </span>
              {isStale && <span className="import-status import-status-stale">（映射已变更）</span>}
            </dd>
          </div>
          <div className="import-detail-row">
            <dt>创建时间</dt>
            <dd>{formatTime(b.createdAt)}</dd>
          </div>
        </dl>
      </div>

      {/* Mapping form */}
      {(needsMapping || isMappingRequired) && (
        <MappingForm batch={b} onSuccess={() => void reload()} />
      )}

      {/* Validate button (needs_mapping or stale) */}
      {(needsMapping || isStale) && (
        <div className="import-panel">
          <h2>校验</h2>
          {isStale && <p className="import-note">映射已变更，旧校验结果已失效。请重新校验。</p>}
          {validateError && (
            <p className="form-error" role="alert">
              {validateError}
            </p>
          )}
          <div className="import-actions">
            <button
              type="button"
              className="primary"
              disabled={validating || (needsField && !b.mapping?.spellingField)}
              onClick={() => void onValidate()}
            >
              {validating ? "校验中…" : "开始校验"}
            </button>
          </div>
          {needsField && !b.mapping?.spellingField && (
            <p className="import-note">请先确认英文拼写字段映射，再开始校验。</p>
          )}
        </div>
      )}

      {/* Validation summary */}
      {isValidated && b.validationSummary && (
        <div className="import-panel">
          <h2>校验摘要</h2>
          <dl className="import-summary-list">
            <div className="import-summary-row">
              <dt>有效候选</dt>
              <dd>{b.validationSummary.candidates}</dd>
            </div>
            <div className="import-summary-row">
              <dt>文件内重复</dt>
              <dd>{b.validationSummary.duplicates}</dd>
            </div>
            <div className="import-summary-row">
              <dt>系统已有词条</dt>
              <dd>{b.validationSummary.existingEntries}</dd>
            </div>
            <div className="import-summary-row">
              <dt>无效</dt>
              <dd>{b.validationSummary.invalid}</dd>
            </div>
            <div className="import-summary-row">
              <dt>忽略空白</dt>
              <dd>{b.validationSummary.ignored}</dd>
            </div>
            <div className="import-summary-row">
              <dt>总行数</dt>
              <dd>{b.validationSummary.total}</dd>
            </div>
          </dl>
          {/* 后续工单占位：提交有效行（本票不实现提交） */}
          <div className="import-actions import-next-placeholder">
            <button type="button" className="primary" disabled title="提交功能将在后续工单提供">
              提交有效行（后续工单）
            </button>
          </div>
        </div>
      )}

      {/* Row table (validated only) */}
      {isValidated && (
        <RowTable
          rows={rows}
          loading={rowsLoading}
          nextCursor={rowsCursor}
          hasMore={rowsHasMore}
          onLoadMore={() => void loadMoreRows()}
        />
      )}

      <div className="import-actions">
        <Link href="/admin/imports" className="secondary">
          返回导入列表
        </Link>
      </div>
    </section>
  );
}

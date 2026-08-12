"use client";

// 管理端导入批次详情页（阶段 6 工单 02 + 03）：
// 唯一任务是「确认映射并校验这个批次 → 仅提交有效候选行 → 下载错误报告」。
// 状态分支：needs_mapping（含 uploaded/not_validated）、validated、committed、validating/failed/stale。
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getImportBatch,
  updateImportMapping,
  validateImportBatch,
  listImportRows,
  commitImportBatch,
  downloadImportErrorReport,
  type ImportBatch,
  type ImportCommitResult,
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
              <th>校验分类</th>
              <th>提交状态</th>
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
                <td>
                  {r.commitStatus === "committed" ? (
                    <span className="import-status import-status-committed">已提交</span>
                  ) : (
                    <span className="import-status import-status-not-committed">未提交</span>
                  )}
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

/**
 * 已校验状态下的提交面板：展示可提交候选数、错误报告下载、唯一强主操作「提交有效行」。
 * 提交前用聚焦确认面板要求显式确认（候选数 + 映射版本 + 明确说明创建可追踪词条/来源
 * 事实且绝不创建课程/发布）。
 */
function CommitPanel({
  batch,
  onCommitted,
}: {
  batch: ImportBatch;
  onCommitted: (result: ImportCommitResult) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState("");
  const [reportError, setReportError] = useState("");
  const commitKeyRef = useRef<string | null>(null);

  const candidates = batch.validationSummary?.candidates ?? 0;
  const invalid = batch.validationSummary?.invalid ?? 0;
  const duplicates = batch.validationSummary?.duplicates ?? 0;
  const existingEntries = batch.validationSummary?.existingEntries ?? 0;
  // 真正不可提交的行数：invalid + duplicate_in_file。existing_entry 是可关联/可提交行，
  // 不计入错误报告数量。
  const nonCommittableCount = invalid + duplicates;
  const hasNonCommittable = nonCommittableCount > 0;

  async function onDownloadReport(): Promise<void> {
    setReportError("");
    const res = await downloadImportErrorReport(batch.id);
    if (!res.ok || res.csv === undefined) {
      setReportError(res.error ?? "下载失败");
      return;
    }
    // 浏览器触发下载（服务端生成内容 + 安全文件名）。
    const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.filename ?? `motro-import-error-report-${batch.id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function onConfirmCommit(): Promise<void> {
    if (!commitKeyRef.current) {
      commitKeyRef.current =
        globalThis.crypto?.randomUUID?.().toString() ?? `commit-${Date.now()}-${Math.random()}`;
    }
    setCommitting(true);
    setCommitError("");
    // P1-1：必须原样回传批次详情暴露的提交确认身份（mappingVersion + validationInputSha256）。
    const confirmation = batch.commitConfirmation;
    if (!confirmation) {
      setCommitting(false);
      setCommitError("批次尚未校验通过或已过期，请刷新后重试");
      commitKeyRef.current = null;
      return;
    }
    const res = await commitImportBatch(
      batch.id,
      {
        mappingVersion: confirmation.mappingVersion,
        validationInputSha256: confirmation.validationInputSha256,
      },
      commitKeyRef.current,
    );
    setCommitting(false);
    if (!res.ok) {
      // 幂等重放不视为错误；其余错误就近展示。
      if (res.status === 409) {
        const code = (res.error as { code?: string } | undefined)?.code;
        if (code === "IDEMPOTENCY_IN_PROGRESS") {
          setCommitError("上一次提交仍在处理中，请稍后重试");
          return;
        }
      }
      setCommitError(res.error?.message ?? "提交失败");
      if (res.status !== 409) commitKeyRef.current = null;
      return;
    }
    commitKeyRef.current = null;
    setConfirmOpen(false);
    onCommitted(res.data!);
  }

  return (
    <div className="import-panel">
      <h2>提交有效行</h2>
      <p className="import-note">
        会把 <strong>{candidates}</strong> 行有效候选创建为全局词条，并关联{" "}
        <strong>{existingEntries}</strong> 行系统已有词条（
        <code>existing_entry</code>）为可追踪的导入来源事实；invalid、文件内重复行不会被新建。
      </p>
      {hasNonCommittable && (
        <div className="import-actions">
          <button type="button" className="secondary" onClick={() => void onDownloadReport()}>
            下载错误报告（{nonCommittableCount} 行）
          </button>
        </div>
      )}
      {reportError && (
        <p className="form-error" role="alert">
          {reportError}
        </p>
      )}
      {commitError && (
        <p className="form-error" role="alert">
          {commitError}
        </p>
      )}
      <div className="import-actions">
        <button
          type="button"
          className="primary"
          disabled={
            committing || (candidates === 0 && existingEntries === 0) || !batch.commitConfirmation
          }
          onClick={() => setConfirmOpen(true)}
        >
          {committing ? "提交中…" : "提交有效行"}
        </button>
      </div>
      {candidates === 0 && existingEntries === 0 && (
        <p className="import-note">没有可提交的有效候选行。</p>
      )}

      {/* 聚焦确认面板：非侵入式，标准按钮操作 */}
      {confirmOpen && (
        <div
          className="import-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="commit-confirm-title"
        >
          <div className="import-confirm-body">
            <h3 id="commit-confirm-title">确认提交有效行？</h3>
            <ul className="import-confirm-list">
              <li>
                新建候选行数：<strong>{candidates}</strong>
              </li>
              <li>
                关联已有词条行数：<strong>{existingEntries}</strong>
              </li>
              <li>
                映射版本：<strong>v{batch.mappingVersion}</strong>
              </li>
            </ul>
            <p className="import-note">
              提交将创建可追踪的全局词条与来源事实（
              <code>lexical_sources(import)</code>
              ），并把系统已有词条关联为导入来源。不会创建课程、发布版本或学习内容。
            </p>
            <div className="import-actions">
              <button
                type="button"
                className="primary"
                disabled={committing}
                onClick={() => void onConfirmCommit()}
              >
                {committing ? "提交中…" : "确认提交"}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={committing}
                onClick={() => setConfirmOpen(false)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 已提交状态面板：展示事实性计数，禁用重复主提交操作，
 * 主操作转为「查看审核状态（后续阶段）」占位（非动作信息状态）。
 * 错误报告仍可下载。
 */
function CommittedPanel({ batch, result }: { batch: ImportBatch; result: ImportCommitResult }) {
  const [reportError, setReportError] = useState("");

  async function onDownloadReport(): Promise<void> {
    setReportError("");
    const res = await downloadImportErrorReport(batch.id);
    if (!res.ok || res.csv === undefined) {
      setReportError(res.error ?? "下载失败");
      return;
    }
    const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.filename ?? `motro-import-error-report-${batch.id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const hasNonCommittable = Object.keys(result.skippedCountByDisposition).length > 0;

  return (
    <div className="import-panel">
      <h2>提交结果</h2>
      <dl className="import-summary-list">
        <div className="import-summary-row">
          <dt>新建词条</dt>
          <dd>{result.createdEntryCount}</dd>
        </div>
        <div className="import-summary-row">
          <dt>关联既有词条</dt>
          <dd>{result.associatedExistingEntryCount}</dd>
        </div>
        <div className="import-summary-row">
          <dt>跳过行</dt>
          <dd>{Object.values(result.skippedCountByDisposition).reduce((a, b) => a + b, 0)}</dd>
        </div>
        <div className="import-summary-row">
          <dt>提交行数</dt>
          <dd>{result.committedRowCount}</dd>
        </div>
      </dl>
      {hasNonCommittable && (
        <div className="import-actions">
          <button type="button" className="secondary" onClick={() => void onDownloadReport()}>
            下载错误报告
          </button>
        </div>
      )}
      {reportError && (
        <p className="form-error" role="alert">
          {reportError}
        </p>
      )}
      {/* 后续阶段占位：非动作信息状态，无虚假 AI/任务进度 */}
      <div className="import-actions import-next-placeholder">
        <span className="import-placeholder-info">查看审核状态（后续阶段）</span>
      </div>
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
  const [commitResult, setCommitResult] = useState<ImportCommitResult | null>(null);

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

  /** 提交成功：保存结果并刷新批次详情（获取 committed 状态）。 */
  async function handleCommitted(result: ImportCommitResult): Promise<void> {
    setCommitResult(result);
    await reload();
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
  const isCommitted = b.status === "committed" || commitResult !== null;
  // 提交结果优先用本地刚提交的响应，刷新后回退到批次详情的 commitSummary。
  const effectiveCommitResult = commitResult ?? b.commitSummary ?? null;
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

      {/* Validation summary + commit/committed */}
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
          {isCommitted && effectiveCommitResult ? (
            <CommittedPanel batch={b} result={effectiveCommitResult} />
          ) : (
            <CommitPanel batch={b} onCommitted={(r) => void handleCommitted(r)} />
          )}
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

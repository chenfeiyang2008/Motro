"use client";

// 管理端任务详情页（阶段 6 工单 04）：
// operation 概要 + attempt 时间线 + 脱敏错误；唯一主操作「重试任务」只在可重试状态显示。
// 成功/排队/运行中不伪装可重试；幂等重放与 retry 请求失败均可恢复。
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOperation,
  retryOperation,
  type OperationAttemptSummary,
  type OperationDetail,
} from "@/lib/api";

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  retry_wait: "等待重试",
  succeeded: "已成功",
  failed: "已失败",
  manual_action: "待人工处理",
};

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

export default function AdminOperationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const [retryDone, setRetryDone] = useState(false);
  // 意图级幂等键：网络可重试错误时复用同一键，成功/不可重试失败后清空。
  const intentKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const res = await getOperation(id);
    setLoading(false);
    if (!res.ok || !res.data) {
      setLoadError(res.error?.message ?? "加载任务详情失败，请重试");
      return;
    }
    setDetail(res.data);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function generateIntentKey(): string {
    return (
      globalThis.crypto?.randomUUID?.().toString() ??
      `op-retry-${Math.random().toString(36).slice(2)}-${Date.now()}`
    );
  }

  async function onRetry(): Promise<void> {
    if (!detail) return;
    intentKeyRef.current ??= generateIntentKey();
    const key = intentKeyRef.current;
    setRetrying(true);
    setRetryError("");
    setRetryDone(false);
    const res = await retryOperation(detail.operation.id, key);
    setRetrying(false);
    if (!res.ok) {
      const retryable = res.status === 0 || res.error?.retryable === true;
      if (!retryable) intentKeyRef.current = null;
      setRetryError(
        res.error?.message ??
          (retryable ? "网络连接失败，请点击重试任务重试" : "重试失败，请稍后再试"),
      );
      return;
    }
    intentKeyRef.current = null;
    setRetryDone(true);
    void load();
  }

  const op = detail?.operation;
  const canRetry = op?.canRetry === true;
  const hasNoLoadIssue = !loading && loadError === "" && detail !== null;

  return (
    <section className="admin-operation-detail">
      <p>
        <Link href="/admin/operations" className="operations-back">
          ← 返回任务列表
        </Link>
      </p>
      <h1>任务详情</h1>

      {loading && <p role="status">正在加载任务详情…</p>}
      {!loading && loadError !== "" && (
        <p role="alert">
          {loadError}
          <button type="button" className="secondary" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}

      {hasNoLoadIssue && op && (
        <>
          <div className="operation-summary">
            <h2>概览</h2>
            <dl className="operation-facts">
              <div>
                <dt>类型</dt>
                <dd>{op.operationType}</dd>
              </div>
              <div>
                <dt>目标</dt>
                <dd>
                  {op.targetType} · {op.targetId}
                </dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>
                  <span className={`operations-status operations-status--${op.status}`}>
                    {statusLabel(op.status)}
                  </span>
                </dd>
              </div>
              <div>
                <dt>尝试次数</dt>
                <dd>
                  {op.attemptCount}/{op.maxAttempts}
                </dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{formatTime(op.createdAt)}</dd>
              </div>
              <div>
                <dt>最近更新</dt>
                <dd>{formatTime(op.updatedAt)}</dd>
              </div>
              {op.lastErrorCode !== undefined && (
                <div>
                  <dt>最近错误码</dt>
                  <dd>
                    <code>{op.lastErrorCode}</code>
                  </dd>
                </div>
              )}
              {op.lastErrorSummary !== undefined && (
                <div>
                  <dt>脱敏摘要</dt>
                  <dd className="operation-error-summary">{op.lastErrorSummary}</dd>
                </div>
              )}
            </dl>
          </div>

          <div className="operation-retry-panel">
            {canRetry && (
              <button
                type="button"
                className="primary"
                disabled={retrying}
                onClick={() => void onRetry()}
              >
                {retrying ? "重试中…" : retryDone ? "已重新排入队列" : "重试任务"}
              </button>
            )}
            {!canRetry && op.status !== "succeeded" && (
              <p className="operation-no-retry">当前状态不允许多人重试。</p>
            )}
            {retryError !== "" && (
              <p role="alert" className="form-error">
                {retryError}
                {retryDone ? (
                  ""
                ) : (
                  <button type="button" className="secondary" onClick={() => void onRetry()}>
                    重试
                  </button>
                )}
              </p>
            )}
            {retryDone && (
              <p role="status" className="form-success">
                已重新排入队列，任务将异步执行。
              </p>
            )}
          </div>

          <div className="operation-attempts">
            <h2>执行记录（attempt 时间线）</h2>
            {detail!.attempts.length === 0 && <p className="operations-empty">尚无执行记录。</p>}
            {detail!.attempts.length > 0 && (
              <table className="operations-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>开始</th>
                    <th>结束</th>
                    <th>结果</th>
                    <th>错误摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {detail!.attempts.map((a: OperationAttemptSummary) => (
                    <tr key={a.id}>
                      <td>{a.attemptNumber}</td>
                      <td>{formatTime(a.startedAt)}</td>
                      <td>{formatTime(a.finishedAt)}</td>
                      <td>{a.outcome ?? "运行中"}</td>
                      <td className="operation-error-cell">
                        {a.errorCode ? <code>{a.errorCode}</code> : null}
                        {a.errorSummary && <span>{a.errorSummary}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  );
}

"use client";

// 管理端审核详情页（Ticket 18）：对一个 AI 草稿做不可变人工审核决定的工作台。
// 信息层级（严格遵守）：
//   - 左侧只读来源事实（Wiktionary projection：spelling、revision、license、attribution）
//   - 右侧 AI 草稿（DeepSeek 中文释义）被明确标注为「AI 草稿」，可被审核员编辑/覆盖
//   - 审核决定：accept / accept_with_edits / reject；操作在确认层里显式提交
//   - 可补全 manual_action 草稿以 empty meaning 出现 → 必须用 accept_with_edits 填真实含义
//   - 历史决定以 append-only 账本展示（/history），只读；重放会冻结结果不重复新增
// 安全边界：绝不展示 provider payload / prompt / 哈希 / 内部路径 / 原始渲染。
// 敏感参数（expectedVersion / reviewVersion）用于乐观并发（409 stale-review 防护）。
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getReviewDraftDetail,
  getReviewHistory,
  resolveReviewManualAction,
  submitReviewDecision,
  type ReviewDraftDetail,
  type ReviewDraftListItem,
  type ReviewDecisionResponse,
} from "@/lib/api";
import {
  generateReviewIntentKey,
  manualActionExplanation,
  requiresRealMeaning,
  reviewActionLabel,
  reviewActionSet,
  reviewDecisionLabel,
  reviewStatusBadgeClass,
  reviewStatusLabel,
} from "@/lib/review-helpers";

function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN");
}

type DecisionAction = "accept" | "accept_with_edits" | "reject";

interface PageState {
  phase: "loading" | "error" | "ready";
  message?: string;
  detail?: ReviewDraftDetail;
}

export default function AdminReviewDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const draftId = typeof params.id === "string" ? params.id : "";

  const [state, setState] = useState<PageState>({ phase: "loading" });
  const [history, setHistory] = useState<ReviewDraftListItem[]>([]);
  const [historyError, setHistoryError] = useState("");

  // 决策表单状态
  const [meaning, setMeaning] = useState("");
  const [hint, setHint] = useState("");
  const [reason, setReason] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<DecisionAction | null>(null);
  const [replay, setReplay] = useState<ReviewDecisionResponse | null>(null);
  const [conflict, setConflict] = useState(false);

  // 决策意图幂等键：目标 + 动作 + 载荷快照一致则复用；失败可重试复用，成功/换意图清空。
  const intentRef = useRef<{ key: string; kind: "decision" | "resolve" } | null>(null);

  // manual_action resolve 状态
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveReason, setResolveReason] = useState("");
  const [resolveError, setResolveError] = useState("");

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const res = await getReviewDraftDetail(draftId);
    if (res.status === 404) {
      router.replace("/admin/reviews");
      return;
    }
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (!res.ok || !res.data) {
      setState({ phase: "error", message: res.error?.message ?? "加载审核草稿失败" });
      return;
    }
    setState({ phase: "ready", detail: res.data });
    // 预填可编辑字段：普通草稿回填含义；manual_action empty 草稿保持空待审核员填写。
    setMeaning(res.data.simplifiedChineseMeaning ?? "");
    setHint(res.data.learningHint ?? "");
    await loadHistory();
  }, [draftId, router]);

  const loadHistory = useCallback(async () => {
    const res = await getReviewHistory(draftId);
    if (res.ok && res.data) {
      setHistory(res.data.items);
      setHistoryError("");
    } else {
      setHistoryError(res.error?.message ?? "历史决定加载失败");
    }
  }, [draftId]);

  useEffect(() => {
    if (draftId) void load();
  }, [draftId, load]);

  // ---- 决策提交 ----
  async function submitDecision(action: DecisionAction): Promise<void> {
    if (!state.detail) return;
    const detail = state.detail;
    const mustProvideMeaning = requiresRealMeaning(detail);
    // 需真实含义但未填写 → 就地拦截，不发起请求。
    if (mustProvideMeaning && action !== "reject" && meaning.trim() === "") {
      setReviewError("该草稿没有原始含义，请填写中文释义后再接受。");
      return;
    }
    if (action === "reject" && reason.trim() === "") {
      setReviewError("驳回必须填写理由。");
      return;
    }
    setBusy(true);
    setReviewError("");
    setConflict(false);
    setReplay(null);
    // 意图键：首次提交生成；重试复用同一键（同一意图）。
    if (!intentRef.current || intentRef.current.kind !== "decision") {
      intentRef.current = { key: generateReviewIntentKey(), kind: "decision" };
    }
    const key = intentRef.current.key;
    const body: {
      decision: DecisionAction;
      reason?: string;
      expectedVersion?: string;
      editedContent?: {
        simplifiedChineseMeaning?: string;
        learningHint?: string;
      };
    } = { decision: action, expectedVersion: detail.reviewVersion };
    if (action === "reject") body.reason = reason.trim();
    if (action === "accept_with_edits") {
      const trimmedReason = reason.trim();
      if (trimmedReason !== "") body.reason = trimmedReason;
      body.editedContent = {};
      if (meaning.trim() !== "") body.editedContent.simplifiedChineseMeaning = meaning.trim();
      if (hint.trim() !== "") body.editedContent.learningHint = hint.trim();
    }
    const res = await submitReviewDecision(draftId, body as never, key);
    setBusy(false);
    if (!res.ok || !res.data) {
      const retryable = res.status === 0 || res.error?.retryable === true;
      if (!retryable) intentRef.current = null;
      if (res.status === 409) {
        const code = res.error?.code;
        if (code === "IDEMPOTENCY_IN_PROGRESS") {
          setReviewError("该审核意图仍在处理中，请稍后重试");
          return;
        }
        // 2332 stale-review → 重新加载详情并提示冲突。
        setConflict(true);
        setReviewError(res.error?.message ?? "草稿已被并发更新，请重新加载后重试");
        intentRef.current = null;
        void load();
        return;
      }
      setReviewError(
        res.error?.message ?? (retryable ? "网络连接失败，请点击重试" : "提交审核决定失败，请重试"),
      );
      return;
    }
    // 成功：冻结重放结果，清空意图并重新加载（历史账本会更新）。
    intentRef.current = null;
    setReplay(res.data);
    setConfirm(null);
    setReason("");
    await load();
  }

  // ---- manual_action resolve ----
  async function submitResolve(): Promise<void> {
    if (resolveReason.trim() === "") {
      setResolveError("人工处理必须填写理由。");
      return;
    }
    setBusy(true);
    setResolveError("");
    if (!intentRef.current || intentRef.current.kind !== "resolve") {
      intentRef.current = { key: generateReviewIntentKey(), kind: "resolve" };
    }
    const key = intentRef.current.key;
    const res = await resolveReviewManualAction(draftId, { reason: resolveReason.trim() }, key);
    setBusy(false);
    if (!res.ok) {
      const retryable = res.status === 0 || res.error?.retryable === true;
      if (!retryable) intentRef.current = null;
      setResolveError(
        res.error?.message ?? (retryable ? "网络连接失败，请点击重试" : "人工处理提交失败，请重试"),
      );
      return;
    }
    intentRef.current = null;
    setResolveOpen(false);
    setResolveReason("");
    setReviewError("");
    await load();
  }

  // ---- render ----
  if (state.phase === "loading") {
    return (
      <section className="admin-review-detail">
        <p role="status">正在加载审核草稿…</p>
      </section>
    );
  }
  if (state.phase === "error" || !state.detail) {
    return (
      <section className="admin-review-detail">
        <h1>审核详情</h1>
        <p className="form-error" role="alert">
          {state.message}
        </p>
        <div className="form-actions">
          <Link href="/admin/reviews" className="secondary">
            返回审核队列
          </Link>
          <button type="button" className="primary" onClick={() => void load()}>
            重试
          </button>
        </div>
      </section>
    );
  }

  const detail = state.detail;
  const actions = reviewActionSet(detail);
  const forceMeaning = actions.forceMeaning;
  const canResolve = forceMeaning; // manual_action（empty meaning）才能 resolve

  return (
    <section className="admin-review-detail">
      <p className="review-back">
        <Link href="/admin/reviews">← 返回审核队列</Link>
      </p>

      <header className="review-detail-header">
        <h1 className="review-spelling">{detail.spelling}</h1>
        <span className={`review-status ${reviewStatusBadgeClass(detail.status)}`}>
          {reviewStatusLabel(detail.status)}
        </span>
        {forceMeaning && <span className="review-badge--manual">需要人工处理</span>}
      </header>

      <p className="review-intro">
        对 AI 生成的词条释义做不可变审核决定。决定会保留操作者、时间与理由，供日后追溯。
      </p>

      {conflict && (
        <p className="form-error" role="alert">
          草稿已被并发更新（乐观并发版本冲突）。请重新加载后再操作。
          <button type="button" className="secondary" onClick={() => void load()}>
            重新加载
          </button>
        </p>
      )}
      {replay && replay.isIdempotentReplay && (
        <p className="form-success" role="status">
          已复用同一次审核意图（{reviewDecisionLabel(replay.decision.decisionType)}），未重复提交。
        </p>
      )}
      {reviewError !== "" && !conflict && (
        <p className="form-error" role="alert">
          {reviewError}
        </p>
      )}

      <div className="review-detail-grid">
        {/* 左侧：只读来源事实 */}
        <div className="review-source-panel">
          <h2>来源与 Provenance</h2>
          <p className="review-readonly-note">来源事实为不可变记录，仅供查看。</p>
          <dl className="review-source-dl">
            <div>
              <dt>来源</dt>
              <dd>{detail.source.sourceName}</dd>
            </div>
            <div>
              <dt>页面 ID</dt>
              <dd>{detail.source.pageId}</dd>
            </div>
            <div>
              <dt>修订版本</dt>
              <dd>{detail.source.revisionId}</dd>
            </div>
            <div>
              <dt>修订时间</dt>
              <dd>{formatTime(detail.source.revisionTimestamp)}</dd>
            </div>
            <div>
              <dt>来源 URL</dt>
              <dd>
                <a
                  href={detail.source.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="review-source-link"
                >
                  {detail.source.sourceUrl}
                </a>
              </dd>
            </div>
            <div>
              <dt>许可证</dt>
              <dd>
                {detail.source.licenseName}
                {detail.source.licenseVersion ? ` · ${detail.source.licenseVersion}` : ""}
                {detail.source.licenseUrl ? (
                  <>
                    {" · "}
                    <a
                      href={detail.source.licenseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="review-source-link"
                    >
                      许可证详情
                    </a>
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>署名</dt>
              <dd>{detail.source.attribution}</dd>
            </div>
          </dl>
        </div>

        {/* 右侧：AI 草稿 + 决策 */}
        <div className="review-decision-panel">
          <h2>AI 草稿与审核决定</h2>
          <p className="review-ai-warning" role="note">
            AI 生成内容仅供参考，审核员须确认准确性与适切性后再接受。
          </p>

          {forceMeaning && (
            <p className="review-manual-hint" role="note">
              {manualActionExplanation("DRAFT_BUDGET_EXCEEDED")}
              。该草稿没有原始释义，必须填写真实中文含义后才能接受。
            </p>
          )}

          <form
            className="review-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirm) void submitDecision(confirm);
            }}
            noValidate
          >
            <label htmlFor="review-meaning">中文释义</label>
            <textarea
              id="review-meaning"
              value={meaning}
              onChange={(e) => setMeaning(e.target.value)}
              rows={3}
              placeholder={forceMeaning ? "请填写真实中文含义…" : "Keep or edit the AI meaning…"}
            />
            {forceMeaning && meaning.trim() === "" && (
              <p className="field-error" role="alert">
                需要真实中文含义后才能接受。
              </p>
            )}

            <label htmlFor="review-hint">学习提示（可选）</label>
            <input id="review-hint" value={hint} onChange={(e) => setHint(e.target.value)} />

            <label htmlFor="review-reason">理由（可选，驳回必填）</label>
            <textarea
              id="review-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="填写审核理由，便于日后追溯…"
            />

            {reviewError !== "" && !conflict && (
              <p className="field-error" role="alert">
                {reviewError}
              </p>
            )}

            <div className="review-action-bar">
              {actions.canAccept && !forceMeaning && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => setConfirm("accept")}
                >
                  {reviewActionLabel("accept")}
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={busy || (forceMeaning && meaning.trim() === "")}
                onClick={() => setConfirm("accept_with_edits")}
              >
                {reviewActionLabel("accept_with_edits")}
              </button>
              <button
                type="button"
                className="secondary danger"
                disabled={busy}
                onClick={() => {
                  setConfirm("reject");
                }}
              >
                {reviewActionLabel("reject")}
              </button>
            </div>
          </form>

          {/* manual_action resolve（独立于审核决定；仅空含义草稿） */}
          {canResolve && (
            <div className="review-manual-resolve">
              <p className="review-manual-note">
                这是一个需要人工处理的草稿。人工处理会记录一条不可变的人工处理事实，作为「已处理」的权威记录。
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setResolveError("");
                  setResolveOpen(true);
                }}
              >
                人工处理
              </button>
            </div>
          )}

          {resolveOpen && (
            <div className="dialog-backdrop" role="presentation">
              <div
                className="review-resolve-layer"
                role="dialog"
                aria-modal="true"
                aria-labelledby="resolve-title"
              >
                <h2 id="resolve-title">确认人工处理</h2>
                <label htmlFor="resolve-reason">处理理由</label>
                <textarea
                  id="resolve-reason"
                  value={resolveReason}
                  onChange={(e) => setResolveReason(e.target.value)}
                  rows={2}
                />
                {resolveError !== "" && (
                  <p className="form-error" role="alert">
                    {resolveError}
                  </p>
                )}
                <p className="review-resolve-note">
                  将记录一条不可变的人工处理事实（append-only），不会直接放行审核。
                </p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setResolveOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void submitResolve()}
                  >
                    {busy ? "处理中…" : "确认处理"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 决策确认层 */}
          {confirm !== null && (
            <div className="dialog-backdrop" role="presentation">
              <div
                className="review-confirm-layer"
                role="dialog"
                aria-modal="true"
                aria-labelledby="decision-confirm-title"
              >
                <h2 id="decision-confirm-title">确认{reviewActionLabel(confirm)}？</h2>
                {confirm === "accept" && forceMeaning && (
                  <p className="form-error" role="alert">
                    该草稿无原始含义，不能直接接受。
                  </p>
                )}
                <p className="review-confirm-note">
                  该审核决定为不可变记录，提交后将无法修改。决定会保留操作者、时间与理由。
                </p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || (confirm === "accept" && forceMeaning)}
                    onClick={() => void submitDecision(confirm)}
                  >
                    {busy ? "提交中…" : "确认提交"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 历史决定账本（append-only 只读） */}
      <div className="review-history-panel">
        <h2>历史决定</h2>
        {historyError !== "" && (
          <p className="form-error" role="alert">
            {historyError}
          </p>
        )}
        {history.length === 0 ? (
          <p className="review-empty">还没有审核决定。</p>
        ) : (
          <table className="reviews-table">
            <thead>
              <tr>
                <th scope="col">决定</th>
                <th scope="col">时间</th>
                <th scope="col">来源</th>
              </tr>
            </thead>
            <tbody>
              {history.map((d) => (
                <tr key={d.draftId}>
                  <td>
                    <span className="review-decision-pill">
                      {reviewDecisionLabel(d.decisionType ?? "—")}
                    </span>
                  </td>
                  <td>{formatTime(d.createdAt)}</td>
                  <td>
                    {d.source.sourceName} · {d.spelling}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

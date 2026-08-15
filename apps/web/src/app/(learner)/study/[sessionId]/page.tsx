"use client";

// 专注学习页：一次处理一张学习卡。
// - 隐藏全局学习者导航（见 (learner)/layout.tsx），只有最小 Glass header（返回/进度）。
// - 词面/答案/方向/提示一律来自 active session 计划项自带的「会话冻结 release 快照」
//   （direction/englishSpelling/meaning/hint），绝不读取 current release 或 /study/cards，
//   保证管理员切换发布版本后旧会话语义不变。
// - reveal 前只有“显示答案”；reveal 后显示答案与四级评分（Again/Hard/Good/Easy，快捷键 1–4）。
// - 评分幂等：同一次评分意图生成固定 clientEventId。网络失败只允许「同一 clientEventId +
//   同一 rating」的重试；用户不能改选其他 rating 复用旧 ID。仅在成功或明确不可重试错误后清理。
// - URL 校验：取得的 active 会话 sessionId 必须等于 URL 段；不匹配则 replace 到正确地址。
// - 会话完成自动进入结果页；未提交的 reveal 状态离开需确认（对话框，Escape 可关闭、焦点受陷）。
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getActiveStudySession,
  revealStudyItem,
  submitStudyReview,
  type StudySessionDetail,
  type StudySessionItem,
} from "@/lib/api";

const RATINGS: { key: "again" | "hard" | "good" | "easy"; label: string; shortcut: string }[] = [
  { key: "again", label: "Again", shortcut: "1" },
  { key: "hard", label: "Hard", shortcut: "2" },
  { key: "good", label: "Good", shortcut: "3" },
  { key: "easy", label: "Easy", shortcut: "4" },
];

/** 以服务端 cursor 定位会话的当前待评分/待展示项。 */
function currentItemOf(detail: StudySessionDetail): StudySessionItem | null {
  const cursor = detail.session.cursor;
  return detail.items.find((i) => i.position === cursor) ?? null;
}

export interface SessionResultSnapshot {
  sessionId: string;
  startedAt: string;
  totalItems: number;
  completedCount: number;
  /** 计划项分类计数（来自会话计划快照）。 */
  byKind: { newLearning: number; initial: number; review: number };
}

const RESULT_SNAPSHOT_KEY = "motro.result-snapshot";

/** 正常完成路径：把「本会话已接受事件」的最小展示快照写入 sessionStorage（仅展示缓存，非进度真相）。 */
function saveResultSnapshot(snapshot: SessionResultSnapshot): void {
  try {
    sessionStorage.setItem(RESULT_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // sessionStorage 不可用（隐私模式等）时忽略：结果页会退回诚实的完成状态。
  }
}

export function readResultSnapshot(): SessionResultSnapshot | null {
  try {
    const raw = sessionStorage.getItem(RESULT_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionResultSnapshot;
    if (!parsed || typeof parsed.sessionId !== "string" || typeof parsed.totalItems !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearResultSnapshot(): void {
  try {
    sessionStorage.removeItem(RESULT_SNAPSHOT_KEY);
  } catch {
    // 忽略：结果页已读取快照。
  }
}

type PageState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "session"; detail: StudySessionDetail }
  | { phase: "redirect"; to: string };

/** 评分意图：同一 clientEventId 只配一个 rating，网络重试绝不换 rating 复用旧 ID。 */
interface PendingRating {
  clientEventId: string;
  rating: "again" | "hard" | "good" | "easy";
}

export default function StudyPage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

  const [state, setState] = useState<PageState>({ phase: "loading" });
  const [currentItem, setCurrentItem] = useState<StudySessionItem | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // 就地错误是否为「会话恢复失败」（区别于评分意图重试）：为 true 时显示“重试恢复”。
  const [recoverable, setRecoverable] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // 待重试的评分意图：同一意图网络失败后保留，直到成功或不可重试才清理。
  const pendingRating = useRef<PendingRating | null>(null);
  const submittedRef = useRef(false);
  // 最近一次读取到的会话详情，供完成时构造展示快照。
  const detailRef = useRef<StudySessionDetail | null>(null);

  const revealButtonRef = useRef<HTMLButtonElement>(null);
  const firstRatingRef = useRef<HTMLButtonElement>(null);
  const exitButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  /** 由会话计划快照构造最小展示快照并保存（仅本会话已接受事件的展示缓存）。 */
  function recordCompletedSnapshot(
    detail: StudySessionDetail,
    justCompleted?: StudySessionItem,
  ): void {
    let newLearning = 0;
    let initial = 0;
    let review = 0;
    let completedCount = 0;
    for (const it of detail.items) {
      const isCompleted =
        it.state === "completed" || (justCompleted ? it.itemId === justCompleted.itemId : false);
      if (isCompleted) {
        completedCount++;
        if (it.itemKind === "new_learning") newLearning++;
        else if (it.itemKind === "initial_review") initial++;
        else review++;
      }
    }
    saveResultSnapshot({
      sessionId: detail.session.sessionId,
      startedAt: detail.session.startedAt,
      totalItems: detail.items.length,
      completedCount,
      byKind: { newLearning, initial, review },
    });
  }

  /** 会话完成时跳转结果页（先保存展示快照）。 */
  function goToResult(detail: StudySessionDetail, justCompleted?: StudySessionItem): void {
    recordCompletedSnapshot(detail, justCompleted);
    router.replace(`/study/${detail.session.sessionId}/result`);
  }

  /** 应用已读取的会话详情：校验 URL，定位当前项，装配页面状态。 */
  function applyDetail(detail: StudySessionDetail): "ok" | "redirected" {
    // P2-1：绝不把任意 URL 伪装成当前会话；sessionId 不一致则 replace 到正确的会话地址。
    if (detail.session.sessionId !== sessionId) {
      router.replace(`/study/${detail.session.sessionId}`);
      setState({ phase: "redirect", to: detail.session.sessionId });
      return "redirected";
    }
    if (detail.session.status !== "active") {
      goToResult(detail);
      return "redirected";
    }
    setState({ phase: "session", detail });
    detailRef.current = detail;
    const item = currentItemOf(detail);
    setCurrentItem(item);
    // 恢复时若当前项已被 reveal（shown），直接显示答案，不强制重新 reveal。
    setRevealed(item?.state === "shown");
    setError("");
    setRecoverable(false);
    return "ok";
  }

  /** 网络失败仍保留意图 → 返回 retryable；否则返回 false。 */
  function isRetryableNetwork(res: {
    ok: boolean;
    status: number;
    error?: { code?: string; retryable?: boolean };
  }): boolean {
    return !res.ok && res.status === 0 && res.error?.code === "NETWORK_ERROR";
  }

  /** 统一处理 active 会话读取结果：401/403 → 跳登录/改密；404 → 无会话回首页；其余可恢复。 */
  function classifyLoad(
    res: Awaited<ReturnType<typeof getActiveStudySession>>,
  ): "auth-redirect" | "no-session" | "recoverable" | "ok" {
    if (res.status === 401) {
      router.replace("/login");
      return "auth-redirect";
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return "auth-redirect";
    }
    // 只有真正的「无 active 会话」404 才回首页；网络/5xx 等其他失败是可恢复的。
    if (res.status === 404) return "no-session";
    if (!res.ok || !res.data) return "recoverable";
    return "ok";
  }

  /** 初始加载：404 无会话回首页；网络/5xx 显示带 h1 的可重试错误状态。 */
  async function loadSession(): Promise<void> {
    setState({ phase: "loading" });
    const res = await getActiveStudySession();
    const kind = classifyLoad(res);
    if (kind === "auth-redirect" || kind === "no-session") {
      if (kind === "no-session") router.replace("/");
      return;
    }
    if (kind === "recoverable") {
      // 初始加载失败：不清空当前卡（本就无卡），展示可重试错误；不触碰 pendingRating。
      setState({ phase: "error", message: loadErrorMessage(res) });
      return;
    }
    applyDetail(res.data!);
  }

  useEffect(() => {
    if (!sessionId) {
      router.replace("/");
      return;
    }
    void loadSession();
  }, [sessionId]);

  /** 以服务端为准重读 active 会话并定位当前项。 */
  const refreshFrom = useCallback(async (): Promise<void> => {
    const res = await getActiveStudySession();
    const kind = classifyLoad(res);
    if (kind === "auth-redirect" || kind === "no-session") {
      if (kind === "no-session") router.replace("/");
      return;
    }
    if (kind === "recoverable") {
      // 网络/5xx：保留当前卡、revealed 状态与 pendingRating（不清除、不换 clientEventId），
      // 就地显示可重试错误，绝不回首页。
      setError("连接失败，当前内容仍在。可“重试恢复”继续。");
      setRecoverable(true);
      return;
    }
    if (applyDetail(res.data!) === "redirected") return;
    // 已推进到新的一项：允许对下一张卡评分；同一意图的幂等键只在单卡评分周期内有效。
    submittedRef.current = false;
    pendingRating.current = null;
  }, [router, sessionId]);

  const doReveal = useCallback(async () => {
    if (state.phase !== "session" || revealed || submitting || !currentItem) return;
    setError("");
    setSubmitting(true);
    const res = await revealStudyItem(sessionId, currentItem.itemId);
    setSubmitting(false);
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (!res.ok) {
      // reveal 失败保留当前卡；网络失败可重试，其余显示错误。
      setError(res.error?.message ?? "显示答案失败，请重试");
      if (res.status === 404) void refreshFrom();
      return;
    }
    setRevealed(true);
    requestAnimationFrame(() => firstRatingRef.current?.focus());
  }, [state.phase, revealed, submitting, currentItem, sessionId, router, refreshFrom]);

  /** 首次发起或重试：同一 pendingRating 必须同一 clientEventId + 同一 rating。 */
  const submitRating = useCallback(
    async (rating: "again" | "hard" | "good" | "easy") => {
      if (
        state.phase !== "session" ||
        submitting ||
        submittedRef.current ||
        !currentItem ||
        !revealed
      ) {
        return;
      }
      // 网络失败后已锁定一个评分意图：只允许「同一 rating」的重试（复用同一 clientEventId）。
      // 用户改选其他 rating 直接丢弃，不生成新 UUID、不替换 pendingRating、不发送第二个请求。
      const pending = pendingRating.current;
      if (pending) {
        if (pending.rating !== rating) return;
      } else {
        pendingRating.current = { clientEventId: crypto.randomUUID(), rating };
      }
      const intent = pendingRating.current;

      const trySubmit = async (): Promise<Awaited<ReturnType<typeof submitStudyReview>>> => {
        return submitStudyReview(sessionId, {
          sessionItemId: currentItem.itemId,
          cardId: currentItem.cardId,
          rating: intent!.rating,
          clientEventId: intent!.clientEventId,
        });
      };

      setSubmitting(true);
      setError("");
      let ratingRes = await trySubmit();

      // 网络失败：自动幂等重试一次（同一 clientEventId + 同一 rating）。
      if (isRetryableNetwork(ratingRes)) {
        ratingRes = await trySubmit();
      }

      setSubmitting(false);

      if (ratingRes.status === 401) {
        router.replace("/login");
        return;
      }
      if (ratingRes.status === 403) {
        router.replace("/change-password");
        return;
      }
      if (!ratingRes.ok || !ratingRes.data) {
        // 网络仍失败：保留同一意图，让用户明确“重新提交 {rating}”（同 ID 同 rating）。
        if (isRetryableNetwork(ratingRes)) {
          setError(networkRetryMessage(intent!.rating));
          return;
        }
        // 明确不可重试错误（409/422/404 或服务端 5xx）：就地提示，保留当前卡；
        // 幂等键只对当次评分意图有效 → 清理 pendingRating。
        setError(ratingRes.error?.message ?? "提交评分失败，请重试");
        pendingRating.current = null;
        if (ratingRes.status === 409 || ratingRes.status === 404) void refreshFrom();
        return;
      }

      const data = ratingRes.data;
      // 成功：意图服务端已接受，清理该评分意图（幂等键本次不再复用）。
      submittedRef.current = true;
      pendingRating.current = null;

      if (data.sessionCompleted) {
        // 会话完成：用本次已接受事件的最小快照进入结果页。
        const detail = detailRef.current;
        if (detail) {
          goToResult(detail, currentItem ?? undefined);
        } else {
          router.push(`/study/${sessionId}/result`);
        }
        return;
      }

      // 以服务端为准推进：重读 active session 得到下一 cursor 项。
      await refreshFrom();
    },
    [state.phase, submitting, currentItem, revealed, sessionId, router, refreshFrom],
  );

  /** 明确「重新提交 {rating}」：复用同一 clientEventId 与同一 rating，不换 ID。 */
  const retryPending = useCallback(async () => {
    if (!pendingRating.current) return;
    await submitRating(pendingRating.current.rating);
  }, [submitRating]);

  // 键盘：reveal 前 Enter/Space 触发“显示答案”；reveal 后 1–4 评分；对话框内 Escape 关闭。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (leaving) {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancelLeave();
        }
        return;
      }
      if (state.phase !== "session") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      if (!revealed) {
        if ((e.key === "Enter" || e.key === " ") && e.target === document.body && !submitting) {
          e.preventDefault();
          void doReveal();
        }
        return;
      }
      const idx = ["1", "2", "3", "4"].indexOf(e.key);
      if (idx >= 0 && !submitting) {
        e.preventDefault();
        void submitRating(RATINGS[idx]!.key);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state, revealed, submitting, leaving, doReveal, submitRating]);

  // 对话框焦点陷阱：焦点在对话框内循环；打开时聚焦“继续学习”。
  useEffect(() => {
    if (!leaving) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    first?.focus();
    function trap(e: KeyboardEvent) {
      if (e.key === "Tab") {
        const active = document.activeElement as HTMLElement | null;
        if (!first || !last) return;
        if (e.shiftKey && (active === first || active === dialog)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [leaving]);

  // 未提交的 reveal 状态离开需确认：页面卸载（刷新/关闭）时提示。
  useEffect(() => {
    if (revealed && !submittedRef.current) {
      function onBeforeUnload(e: BeforeUnloadEvent) {
        e.preventDefault();
      }
      window.addEventListener("beforeunload", onBeforeUnload);
      return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }
  }, [revealed]);

  const handleExit = useCallback(() => {
    if (revealed && !submittedRef.current && !leaving) {
      setLeaving(true);
    } else {
      router.push("/");
    }
  }, [revealed, leaving, router]);

  const confirmLeave = useCallback(() => {
    setLeaving(false);
    router.push("/");
  }, [router]);

  const cancelLeave = useCallback(() => {
    setLeaving(false);
    // 关闭后焦点回到“退出”触发按钮。
    requestAnimationFrame(() => exitButtonRef.current?.focus());
  }, []);

  if (state.phase === "loading") {
    return (
      <section className="study-shell">
        <h1>学习会话</h1>
        <p role="status">正在恢复学习…</p>
      </section>
    );
  }

  if (state.phase === "error") {
    return (
      <section className="study-shell">
        <h1>学习会话</h1>
        <p role="alert">{state.message}</p>
        <button type="button" className="primary" onClick={() => void loadSession()}>
          重试
        </button>
      </section>
    );
  }

  if (state.phase === "redirect") {
    return (
      <section className="study-shell">
        <h1>学习会话</h1>
        <p role="status">正在跳转…</p>
      </section>
    );
  }

  // 至此 state.phase 已是 "session"，detail 存在。
  const detail = state.detail;
  const item = currentItem;
  const position = item?.position ?? 0;
  const total = detail.items.length;
  const progressPercent = total > 0 ? Math.min(100, Math.round(((position - 1) / total) * 100)) : 0;

  // 8a. 判断当前项是否仍有待重试的评分意图（用于展示“重新提交 {rating}”）。
  const retryIntent = pendingRating.current;

  return (
    <section className="study-shell">
      {/* 语义 h1：视觉隐藏、读屏与 heading 结构可识别；不放大标题破坏专注学习页。 */}
      <h1 className="visually-hidden">学习会话</h1>
      <div className="study-header glass-surface glass-surface--regular">
        <button
          ref={exitButtonRef}
          type="button"
          className="study-header-exit"
          onClick={handleExit}
        >
          退出
        </button>
        <div className="study-progress">
          <div
            className="progress-track"
            role="progressbar"
            aria-label="学习进度"
            aria-valuenow={position}
            aria-valuemin={1}
            aria-valuemax={Math.max(total, 1)}
            aria-valuetext={`第 ${position} 项，共 ${total} 项`}
          >
            <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <span className="study-progress-text">
            {position} / {total}
          </span>
        </div>
      </div>

      {error !== "" && (
        <p className="study-error" role="alert">
          {error}
        </p>
      )}
      {error !== "" && (recoverable || retryIntent) && (
        <div className="study-error-actions">
          {recoverable && (
            <button
              type="button"
              className="secondary"
              disabled={submitting}
              onClick={() => void refreshFrom()}
            >
              重试恢复
            </button>
          )}
          {retryIntent && (
            <button
              type="button"
              className="secondary"
              disabled={submitting}
              onClick={() => void retryPending()}
            >
              重新提交 {ratingLabel(retryIntent.rating)}
            </button>
          )}
        </div>
      )}

      {item ? (
        <div className="study-card">
          <p className="study-direction">
            {item.direction === "en_to_zh" ? "英文 → 中文" : "中文 → 英文"}
          </p>
          <p
            className={`study-prompt ${item.direction === "en_to_zh" ? "study-text-english" : "study-text-zh"}`}
          >
            {promptText(item)}
          </p>
          {item.hint ? <p className="study-hint">提示：{item.hint}</p> : null}

          {!revealed ? (
            <button
              ref={revealButtonRef}
              type="button"
              className="primary study-reveal-btn"
              disabled={submitting}
              onClick={() => void doReveal()}
            >
              显示答案
            </button>
          ) : (
            <>
              <div className="study-answer">
                <p className="study-answer-label">答案</p>
                <p
                  className={`study-answer-value ${item.direction === "en_to_zh" ? "study-text-zh" : "study-text-english"}`}
                >
                  {answerText(item)}
                </p>
              </div>
              <div className="study-ratings">
                {RATINGS.map((r, i) => (
                  <button
                    key={r.key}
                    ref={i === 0 ? firstRatingRef : undefined}
                    type="button"
                    className="study-rating"
                    // 网络失败且仍持有待重试评分意图时，四个评分按钮全部禁用：
                    // 只能通过下方「重新提交 {rating}」复用同一意图（同一 clientEventId + 同一 rating）。
                    disabled={submitting || pendingRating.current !== null}
                    onClick={() => void submitRating(r.key)}
                  >
                    <span>{r.label}</span>
                    <span className="study-rating-key">快捷键 {r.shortcut}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="study-card">
          <p>会话中没有待处理的内容。</p>
        </div>
      )}

      {leaving && (
        <div className="dialog-backdrop" role="presentation">
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="leave-title">
            <h2 id="leave-title">退出本次学习？</h2>
            <p>当前卡片已显示答案但尚未评分，退出将丢失这次评分。</p>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={cancelLeave}>
                继续学习
              </button>
              <button type="button" className="primary" onClick={confirmLeave}>
                退出
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function promptText(item: StudySessionItem): string {
  return item.direction === "en_to_zh" ? item.englishSpelling : item.meaning;
}

function answerText(item: StudySessionItem): string {
  return item.direction === "en_to_zh" ? item.meaning : item.englishSpelling;
}

function ratingLabel(key: "again" | "hard" | "good" | "easy"): string {
  return RATINGS.find((r) => r.key === key)?.label ?? key;
}

function networkRetryMessage(rating: "again" | "hard" | "good" | "easy"): string {
  return `网络连接失败，尚未保存评分。可“重新提交 ${ratingLabel(rating)}”重试。`;
}

function loadErrorMessage(res: Awaited<ReturnType<typeof getActiveStudySession>>): string {
  if (res.status === 0) return "网络连接失败，无法恢复学习会话，请重试。";
  return res.error?.message ?? "加载学习会话失败，请重试。";
}

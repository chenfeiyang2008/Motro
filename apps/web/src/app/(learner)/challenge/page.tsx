"use client";

// 周挑战答题页（Ticket 21）：专注式布局，不显示 Dock/全局导航。
// 流程完全以服务端为权威：
//   - GET /challenge/current → 冻结 10 题（5 选择 + 5 拼写），服务端排序与内容；
//   - 每题 POST /challenge/attempts/:id/answers/:position（client_event_id 幂等）→ 服务端判分；
//   - 只透传服务端 verdict（isCorrect/pointsAwarded/kind/correctAnswer），前端从不判分/算分；
//   - 只有收到成功响应（或明确的非可重试错误）才进入下一题；网络失败保留输入可重试；
//   - 倒计时结束 / 周截止 → 停止提交进入结束态；
//   - 浏览器刷新后调用 /challenge/current 恢复服务端 active attempt，不从本地伪造。
// 安全边界：不展示 server_answer；判分后才展示 correctAnswer；题目不写 localStorage。
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getChallengeCurrent,
  submitChallengeAnswer,
  type ChallengeCurrentFixed,
  type ChallengeItem,
} from "@/lib/api";
import {
  applyVerdict,
  buildInitialFlow,
  markConflict,
  markEnded,
  markRetryable,
  progressLabel,
  type ChallengeFlowState,
  type ChallengeItemFlow,
  type PerItemState,
  type VerdictFlow,
} from "@/lib/challenge-flow";

const TOTAL_ITEMS = 10;

type PageState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; flow: ChallengeFlowState };

/** 从服务端 ChallengeCurrent 投影正确答案/输入 UI 所需的题面（不泄露 server_answer）。 */
function toItemFlow(i: ChallengeItem): ChallengeItemFlow {
  return {
    position: i.position,
    direction: i.direction as "en_to_zh" | "zh_to_en",
    questionType: i.questionType as "choice" | "spelling",
    englishSpelling: i.englishSpelling,
    meaning: i.meaning,
    choices: i.choices ?? [],
  };
}

function convertInitial(raw: ChallengeCurrentFixed): ChallengeFlowState {
  const input: {
    attemptId: string | null;
    weekKey: string;
    weekEndIso: string;
    expiresAtIso?: string | null;
    items: ChallengeItemFlow[];
    status?: string;
  } = {
    attemptId: raw.attemptId,
    weekKey: raw.challengeWeek,
    weekEndIso: raw.weekEnd,
    expiresAtIso: raw.expiresAt,
    items: raw.items.map(toItemFlow),
  };
  if (raw.status !== undefined) input.status = raw.status;
  return buildInitialFlow(input);
}

export default function ChallengePage() {
  const router = useRouter();
  const [state, setState] = useState<PageState>({ phase: "loading" });

  // 当前题面的输入状态（不写本地存储；仅内存保存，刷新后从服务端恢复）。
  const [input, setInput] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const clientEventRef = useRef<string>("");
  const [nowIso, setNowIso] = useState(() => new Date().toISOString());

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const res = await getChallengeCurrent();
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return;
    }
    if (res.error?.code === "DAILY_USAGE_LIMIT_REACHED") {
      setState({
        phase: "error",
        message: res.error?.message ?? "今日非会员学习时长已达上限，请升级会员或明天继续。",
      });
      return;
    }
    if (!res.ok || !res.data) {
      setState({ phase: "error", message: res.error?.message ?? "加载测验失败，请重试" });
      return;
    }
    setState({ phase: "ready", flow: convertInitial(res.data) });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  // 倒计时：每秒刷新 nowIso；过期后非 completed → ended。
  useEffect(() => {
    if (state.phase !== "ready") return;
    const timer = setInterval(() => setNowIso(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);

  // 过期处理：服务端验证超时，前端仅做本地展示（停止提交）。
  useEffect(() => {
    if (state.phase === "ready" && state.flow.phase === "in_progress") {
      const exp = state.flow.expiresAtIso;
      if (exp && new Date(exp).getTime() <= new Date(nowIso).getTime()) {
        setState({ phase: "ready", flow: markEnded(state.flow) });
      }
    }
  }, [nowIso, state]);

  // ---- 提交当前题 ----
  async function onSubmit(): Promise<void> {
    if (state.phase !== "ready" || submitBusy) return;
    const f = state.flow;
    if (f.phase !== "in_progress" || f.attemptId == null) return;
    const idx = f.currentIndex;
    const item = f.items[idx];
    if (!item) return;
    const cur = f.perItem[idx];
    if (!cur || (cur.phase !== "answering" && cur.phase !== "retryable")) return;
    const answer = input.trim();
    if (item.questionType === "choice" && item.choices.length === 0) {
      setSubmitError("选项暂时不可用，请刷新后重试");
      return;
    }
    if (answer === "" && item.questionType === "spelling") {
      setSubmitError("请输入你的回答");
      return;
    }

    // 每题一次幂等键；重试复用同一键（同一题同一次提交意图）。
    if (!clientEventRef.current) {
      clientEventRef.current =
        typeof crypto !== "undefined" ? crypto.randomUUID() : `qz-${Date.now()}-${Math.random()}`;
    }

    setSubmitBusy(true);
    setSubmitError("");
    const res = await submitChallengeAnswer(f.attemptId, item.position, {
      clientEventId: clientEventRef.current,
      answer,
    });
    setSubmitBusy(false);

    // 401/403 → 登录/改密。
    if (res.status === 401) {
      router.replace("/login");
      return;
    }
    if (res.status === 403) {
      router.replace("/change-password");
      return;
    }

    // DAILY_USAGE_LIMIT_REACHED: non-member exhausted 15-minute budget.
    // Show a dedicated terminal message — no retry, cannot continue.
    if (res.error?.code === "DAILY_USAGE_LIMIT_REACHED") {
      clientEventRef.current = "";
      setState({
        phase: "error",
        message: res.error?.message ?? "今日非会员学习时长已达上限，请升级会员或明天继续。",
      });
      return;
    }

    // 409 并发/重复提交/状态冲突 → 重新获取当前 attempt。
    if (res.status === 409) {
      clientEventRef.current = "";
      setSubmitError(res.error?.message ?? "测验状态已变化，正在重新同步");
      setState({ phase: "ready", flow: markConflict(f) });
      void load();
      return;
    }

    // 404 / 422 → 明确错误。
    if (!res.ok || !res.data) {
      const retryable = res.status === 0 || res.error?.retryable === true;
      clientEventRef.current = "";
      if (res.status === 404 || res.status === 422) {
        setState({
          phase: "ready",
          flow: markRetryable(f, item.position, res.error?.message ?? "该题无效，请刷新后重试"),
        });
        return;
      }
      if (retryable) {
        setState({
          phase: "ready",
          flow: markRetryable(f, item.position, res.error?.message ?? "网络连接失败，请重试"),
        });
        return;
      }
      setState({
        phase: "ready",
        flow: markRetryable(f, item.position, res.error?.message ?? "提交失败，请重试"),
      });
      return;
    }

    // 成功：透传服务端判分，推进到下一题；下一题清空输入与幂等键。
    const verdict: VerdictFlow = {
      isCorrect: res.data.isCorrect,
      pointsAwarded: res.data.pointsAwarded,
      kind: res.data.kind,
      correctAnswer: res.data.correctAnswer,
    };
    const next = applyVerdict(f, item.position, verdict);
    if (next.phase === "completed") {
      setState({ phase: "ready", flow: next });
      // 全部完成 → 结果页：只透传服务端 verdict 累加的只读事实。
      const q = new URLSearchParams({
        correct: String(next.answeredCount),
        points: String(
          next.perItem.reduce(
            (a, p) => a + (p.phase === "answered" ? p.verdict.pointsAwarded : 0),
            0,
          ),
        ),
        reviewed: String(
          next.perItem.filter((p) => p.phase === "answered" && p.verdict.kind === "already_scored")
            .length,
        ),
      });
      router.push(`/challenge/result?${q.toString()}`);
      return;
    }
    setState({ phase: "ready", flow: next });
    setInput("");
    setSubmitError("");
    clientEventRef.current = "";
  }

  // ---- 渲染 ----
  if (state.phase === "loading") {
    return (
      <div className="challenge-shell">
        <p className="challenge-status" role="status">
          正在准备测验…
        </p>
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="challenge-shell">
        <p className="challenge-status challenge-status--error" role="alert">
          {state.message}
        </p>
        <button type="button" className="secondary" onClick={() => void load()}>
          重试
        </button>
        <a href="/leaderboard" className="challenge-back">
          返回周挑战榜
        </a>
      </div>
    );
  }
  const f = state.flow;

  // not_eligible：没有已接触词条。
  if (f.phase === "not_eligible") {
    return (
      <div className="challenge-shell">
        <h1 className="challenge-title">周挑战</h1>
        <p className="challenge-note">
          本周挑战由服务器组题，需要先学习并接触至少 10
          个不同词条后才能参加。请先完成每日学习见到词条。
        </p>
        <a href="/" className="challenge-back">
          返回首页
        </a>
      </div>
    );
  }

  if (f.phase === "conflict") {
    return (
      <div className="challenge-shell">
        <h1 className="challenge-title">周挑战</h1>
        <p className="challenge-status challenge-status--error" role="alert">
          测验状态已变化（可能已在另一窗口作答或已过期），正在恢复最新状态…
        </p>
      </div>
    );
  }

  if (f.phase === "ended") {
    return (
      <div className="challenge-shell">
        <h1 className="challenge-title">测验已结束</h1>
        <p className="challenge-note">周挑战周期已截止或答题时间已用完，本次作答已停止。</p>
        <a href="/leaderboard" className="challenge-back">
          返回周挑战榜
        </a>
      </div>
    );
  }

  if (f.phase === "completed" || f.items.length === 0) {
    // 已完成但仍在本题页（例如刷新后服务端 returns completed）→ 引导到结果页/榜单。
    return (
      <div className="challenge-shell">
        <p className="challenge-status" role="status">
          本次测验已完成。
        </p>
        <a href="/leaderboard" className="challenge-back">
          返回周挑战榜
        </a>
      </div>
    );
  }

  // in_progress
  const idx = f.currentIndex;
  const item = f.items[idx];
  if (!item) return null; // unreachable: currentIndex is always within bounds
  const perItem = f.perItem[idx] ?? ({ phase: "answering" } as PerItemState);
  const answeredVerdict = perItem.phase === "answered" ? perItem.verdict : null;
  const dt = new Date(nowIso).getTime();
  const expiresIso = f.expiresAtIso;
  const secondsLeft = expiresIso
    ? Math.max(0, Math.floor((new Date(expiresIso).getTime() - dt) / 1000))
    : null;
  const mm = secondsLeft !== null ? String(Math.floor(secondsLeft / 60)).padStart(2, "0") : "--";
  const ss = secondsLeft !== null ? String(secondsLeft % 60).padStart(2, "0") : "--";

  return (
    <div className="challenge-shell">
      <header className="challenge-topbar">
        <a href="/leaderboard" className="challenge-exit" aria-label="退出测验">
          退出
        </a>
        <span className="challenge-progress" aria-live="polite">
          {progressLabel(f)}
        </span>
        <span className="challenge-countdown" aria-live="polite">
          {mm}:{ss}
        </span>
      </header>
      <p className="challenge-status challenge-status--sr" aria-live="polite">
        {item.questionType === "choice" ? "选择题" : "拼写题"} · 第 {item.position} / {TOTAL_ITEMS}{" "}
        题
      </p>

      <div className="challenge-question">
        {item.questionType === "choice" ? (
          <>
            <p className="challenge-prompt-en">{item.englishSpelling}</p>
            <p className="challenge-prompt-hint">请选择正确的中文释义</p>
          </>
        ) : (
          <>
            <p className="challenge-prompt-zh">{item.meaning}</p>
            <p className="challenge-prompt-hint">请输入英文拼写</p>
          </>
        )}
        {item.questionType === "choice" && (
          <div className="challenge-choices" role="group" aria-label="中文选项">
            {item.choices.length > 0 ? (
              item.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={`challenge-choice-btn ${input === choice ? "selected" : ""}`}
                  aria-pressed={input === choice}
                  disabled={submitBusy || answeredVerdict !== null}
                  onClick={() => {
                    setInput(choice);
                    setSubmitError("");
                  }}
                >
                  {choice}
                </button>
              ))
            ) : (
              <p className="challenge-note" role="alert">
                选项暂时不可用，请刷新后重试。
              </p>
            )}
          </div>
        )}
        {item.questionType === "spelling" && (
          <input
            className="challenge-spelling-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitBusy) void onSubmit();
            }}
            autoComplete="off"
            spellCheck={false}
            aria-label="英文拼写"
          />
        )}

        {/* 判分反馈（仅服务端返回后） */}
        {answeredVerdict && (
          <div
            className={`challenge-feedback ${answeredVerdict.isCorrect ? "is-correct" : "is-wrong"}`}
            role="status"
          >
            <p>{answeredVerdict.isCorrect ? "✓ 答对了" : "✗ 答错了"}</p>
            {answeredVerdict.kind === "already_scored" && (
              <p className="challenge-feedback-note">该词义方向本周已计分，本题不重复得分。</p>
            )}
            {answeredVerdict.kind === "review" && (
              <p className="challenge-feedback-note">本题为复习题，不重复得分。</p>
            )}
            {answeredVerdict.pointsAwarded > 0 && (
              <p className="challenge-feedback-points">
                +{answeredVerdict.pointsAwarded} Challenge Points
              </p>
            )}
            <p className="challenge-feedback-answer">正确答案：{answeredVerdict.correctAnswer}</p>
          </div>
        )}

        {submitError !== "" && (
          <p className="challenge-error" role="alert">
            {submitError}
            {perItem.phase === "retryable" && (
              <button
                type="button"
                className="secondary"
                disabled={submitBusy}
                onClick={() => void onSubmit()}
              >
                重试
              </button>
            )}
          </p>
        )}

        <div className="challenge-actions">
          <button
            type="button"
            className="primary"
            disabled={submitBusy || (item.questionType === "choice" && item.choices.length === 0)}
            onClick={() => void onSubmit()}
          >
            {submitBusy ? "提交中…" : "提交答案"}
          </button>
        </div>
      </div>

      <p className="challenge-footnote">
        答题速度不影响积分。每周挑战由服务器组题；一个词义方向每周最多获得一次 Challenge Point；
        每日 XP 不进入排行榜。截止时间以服务端返回并按北京时间（Asia/Shanghai）计。
      </p>
    </div>
  );
}

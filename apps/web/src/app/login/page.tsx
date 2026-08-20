"use client";

// 登录页：一次性/常规密码登录；首次登录跳转强制改密。
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { login, warmCsrf } from "@/lib/auth";
import { MotroLogo } from "@/components/motro-logo";

export default function LoginPage() {
  const router = useRouter();
  const usernameRef = useRef<HTMLInputElement>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const redirectTimerRef = useRef<number | null>(null);
  const leavingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void warmCsrf();
    usernameRef.current?.focus();

    return () => {
      if (redirectTimerRef.current !== null) {
        window.clearTimeout(redirectTimerRef.current);
      }
      if (leavingTimerRef.current !== null) {
        window.clearTimeout(leavingTimerRef.current);
      }
    };
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess(false);
    setLeaving(false);
    const res = await login(username, password);
    setBusy(false);
    if (!res.ok || !res.user) {
      setError(res.message ?? "登录失败，请重试");
      return;
    }
    setSuccess(true);
    // 写入"刚登录"信号；会员欢迎层在首页确认服务端会员身份后才决定是否播放。
    // 非会员也写入，让首页可消费并清除旧信号（避免跨会话遗留）。
    try {
      sessionStorage.setItem("motro_just_logged_in_member", "1");
    } catch {
      // sessionStorage 不可用 → 欢迎层保守跳过。
    }
    const nextPath = res.user.mustChangePassword ? "/change-password" : "/app";
    // 动画时间轴（与 globals.css 对齐）：
    //   0ms  success → 胶囊收缩变圆（~500ms）→ 打勾弹出（~550ms）→ 描边（~720ms）
    //   1200ms 整卡淡出上移，1650ms 跳转。
    leavingTimerRef.current = window.setTimeout(() => {
      setLeaving(true);
    }, 1200);
    redirectTimerRef.current = window.setTimeout(() => {
      router.push(nextPath);
    }, 1650);
  }

  return (
    <section
      className={`auth-page${leaving ? " auth-page--leaving" : ""}`}
      aria-labelledby="login-title"
    >
      <div className="auth-card">
        <header className="auth-card__header">
          <div className="auth-brand" aria-label="Motro">
            <span className="auth-brand-mark" aria-hidden="true">
              <MotroLogo />
            </span>
          </div>
          <div className="auth-card__intro">
            <h1 id="login-title" aria-label="登录 Motro">
              <span aria-hidden="true">登录</span>
            </h1>
            <p className="auth-card__description">继续完成今天的学习计划。</p>
          </div>
        </header>

        <div className="auth-card__body">
          {error !== "" && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <form onSubmit={onSubmit} noValidate>
            <div className="auth-field">
              <label className="visually-hidden" htmlFor="username">
                用户名
              </label>
              <input
                id="username"
                ref={usernameRef}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="用户名"
                required
                minLength={1}
              />
            </div>
            <div className="auth-field">
              <label className="visually-hidden" htmlFor="password">
                密码
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="密码"
                required
                minLength={1}
              />
            </div>
            <button
              type="submit"
              className={success ? "auth-submit--success" : undefined}
              disabled={busy || success}
              aria-label={success ? "登录成功" : undefined}
            >
              <span className="auth-submit__label" aria-hidden={success}>
                {busy ? "登录中…" : "登录"}
              </span>
              {success && (
                <span className="auth-submit__check" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 12.5 L9.5 18 L20 6" />
                  </svg>
                </span>
              )}
            </button>
          </form>
        </div>
      </div>
      <p className="auth-page__note">仅限受邀用户使用</p>
    </section>
  );
}

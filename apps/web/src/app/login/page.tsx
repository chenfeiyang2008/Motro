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

  useEffect(() => {
    void warmCsrf();
    usernameRef.current?.focus();
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const res = await login(username, password);
    setBusy(false);
    if (!res.ok || !res.user) {
      setError(res.message ?? "登录失败，请重试");
      return;
    }
    router.push(res.user.mustChangePassword ? "/change-password" : "/app");
  }

  return (
    <section className="auth-form">
      <div className="auth-brand" aria-label="Motro">
        <span className="auth-brand-mark" aria-hidden="true">
          <MotroLogo />
        </span>
        <span className="auth-brand-name">Motro</span>
      </div>
      <h1>登录</h1>
      {error !== "" && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="username">用户名</label>
        <input
          id="username"
          ref={usernameRef}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          minLength={1}
        />
        <label htmlFor="password">密码</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          minLength={1}
        />
        <button type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </section>
  );
}

"use client";

// 首次/当前改密页：验证当前密码，设置新密码后进入受保护页。
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { changePassword, warmCsrf } from "@/lib/auth";

export default function ChangePasswordPage() {
  const router = useRouter();
  const currentRef = useRef<HTMLInputElement>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void warmCsrf();
    currentRef.current?.focus();
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (newPassword.length < 6) {
      setError("新密码至少 6 个字符");
      return;
    }
    if (newPassword !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    const res = await changePassword(currentPassword, newPassword);
    setBusy(false);
    if (!res.ok) {
      setError(res.message ?? "修改失败，请重试");
      return;
    }
    router.push("/app");
  }

  return (
    <section className="auth-form">
      <h1>修改密码</h1>
      {error !== "" && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="current">当前密码</label>
        <input
          id="current"
          ref={currentRef}
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <label htmlFor="new">新密码（至少 6 个字符）</label>
        <input
          id="new"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          required
          minLength={6}
        />
        <label htmlFor="confirm">确认新密码</label>
        <input
          id="confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          minLength={6}
        />
        <button type="submit" disabled={busy}>
          {busy ? "保存中…" : "保存新密码"}
        </button>
      </form>
    </section>
  );
}

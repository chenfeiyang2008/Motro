"use client";

// 受保护占位页：无会话跳转登录；提供登出。
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchMe, logout, type PublicUser } from "@/lib/auth";

export default function ProtectedAppPage() {
  const router = useRouter();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchMe().then((res) => {
      if (cancelled) return;
      if (!res.ok || !res.user) {
        router.replace("/login");
        return;
      }
      if (res.user.mustChangePassword) {
        // 服务端同样强制；前端兜底跳转改密。
        router.replace("/change-password");
        return;
      }
      setUser(res.user);
      setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onLogout() {
    setBusy(true);
    await logout();
    router.replace("/login");
  }

  if (!checked) return <p>正在检查登录状态…</p>;

  return (
    <section>
      <h1>已登录</h1>
      <p>
        你好，{user?.displayName ?? user?.username}（{user?.role}）。受保护占位页。
      </p>
      <button type="button" className="primary" onClick={onLogout} disabled={busy}>
        {busy ? "登出中…" : "登出"}
      </button>
    </section>
  );
}

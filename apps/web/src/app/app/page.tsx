"use client";

// 受保护入口：无会话跳转登录；登录后按角色呈现真实工作台。
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchMe, logout, type PublicUser } from "@/lib/auth";

import LearnerDashboardPage from "../(learner)/page";
import LearnerLayout from "../(learner)/layout";
import AdminHomePage from "../admin/page";
import AdminLayout from "../admin/layout";

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

  if (user?.role === "admin") {
    return (
      <AdminLayout>
        <AdminHomePage />
        <button type="button" className="primary app-logout" onClick={onLogout} disabled={busy}>
          {busy ? "登出中…" : "登出"}
        </button>
      </AdminLayout>
    );
  }

  return (
    <LearnerLayout>
      <LearnerDashboardPage />
      <button type="button" className="primary app-logout" onClick={onLogout} disabled={busy}>
        {busy ? "登出中…" : "登出"}
      </button>
    </LearnerLayout>
  );
}

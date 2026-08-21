"use client";

// 受保护入口：无会话跳转登录；登录后按角色呈现真实工作台。
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchMe, logout, type PublicUser } from "@/lib/auth";

import LearnerDashboardPage from "../(learner)/page";
import LearnerLayout from "../(learner)/layout";
import AdminHomePage from "../admin/page";
import AdminLayout from "../admin/layout";
import { AccountMenu } from "@/components/account-menu";

export default function ProtectedAppPage() {
  const router = useRouter();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

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
    setLogoutError(null);
    const res = await logout();
    setBusy(false);
    if (!res.ok) {
      setLogoutError(res.message ?? "退出失败，请重试。");
      return;
    }
    router.replace("/login");
  }

  if (!checked) return <p>正在检查登录状态…</p>;

  if (!user) return null;

  if (user.role === "admin") {
    return (
      <AdminLayout>
        <AdminHomePage />
      </AdminLayout>
    );
  }

  return (
    <LearnerLayout>
      <LearnerDashboardPage />
      <AccountMenu user={user} onLogout={onLogout} busy={busy} />
      {logoutError && (
        <p className="app-logout-error" role="alert">
          {logoutError}
        </p>
      )}
    </LearnerLayout>
  );
}

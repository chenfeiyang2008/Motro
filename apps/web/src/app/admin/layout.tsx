"use client";

// 管理端外壳：标准后台左贴边侧栏，内容分组导航（spec §4.3）。
// 路由级鉴权守卫：未登录跳转 /login，非管理员显示无权限页，首登未改密跳转改密页。
// 会话密钥/密码/Token 始终在服务端（HttpOnly cookie），客户端只通过 /api/v1/auth/me 校验角色。
// 壳层结构：桌面固定左贴边侧栏（Liquid Glass 仅作用于此功能层），
// 窄屏折叠为可访问菜单；正文/表单/表格保持实体表面。
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/auth";

import { AdminMobileNav } from "@/components/admin/mobile-nav";
import { ADMIN_NAV_GROUPS } from "@/components/admin/nav";
import { AdminSidebar } from "@/components/admin/sidebar";

type AuthState = "loading" | "admin" | "forbidden";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [auth, setAuth] = useState<AuthState>("loading");

  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      const res = await fetchMe();
      if (cancelled) return;
      if (!res.ok || !res.user) {
        // 未登录 → 登录页。
        router.replace("/login");
        return;
      }
      if (res.user.mustChangePassword) {
        // 首次登录未改密：服务端会拒绝管理写操作，先引导改密。
        router.replace("/change-password");
        return;
      }
      if (res.user.role !== "admin") {
        // 已登录但非管理员 → 无权限页。
        setAuth("forbidden");
        return;
      }
      setAuth("admin");
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (auth === "loading") {
    return <p className="admin-auth-loading">正在验证登录…</p>;
  }
  if (auth === "forbidden") {
    return (
      <section className="auth-form">
        <h1>无权限</h1>
        <p>你没有权限访问管理端，请使用管理员账号登录。</p>
        <p>
          <Link href="/app">返回学习端</Link>
        </p>
      </section>
    );
  }

  return (
    <div className="admin-shell">
      {/* 桌面固定侧栏（>=1024px 显示；窄屏隐藏） */}
      <AdminSidebar pathname={pathname} />

      {/* 窄屏折叠菜单（<1024px 显示） */}
      <AdminMobileNav groups={ADMIN_NAV_GROUPS} pathname={pathname} />

      <div className="admin-content">
        {/* 内容区由子页面提供自己的 h1 / section landmark */}
        {children}
      </div>
    </div>
  );
}

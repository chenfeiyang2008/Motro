"use client";

// 管理端外壳：标准后台侧栏，内容分组导航。
// 路由级鉴权守卫：未登录跳转 /login，非管理员显示无权限页，首登未改密跳转改密页。
// 会话密钥/密码/Token 始终在服务端（HttpOnly cookie），客户端只通过 /api/v1/auth/me 校验角色。
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/auth";

const NAV_GROUPS = [
  {
    label: "内容",
    items: [
      { href: "/admin/lexicon", label: "词条" },
      { href: "/admin/courses", label: "课程" },
    ],
  },
  {
    label: "导入",
    items: [{ href: "/admin/imports", label: "导入" }],
  },
  {
    label: "系统",
    items: [{ href: "/admin/operations", label: "任务状态" }],
  },
];

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
      <nav className="admin-sidebar" aria-label="管理端导航">
        {NAV_GROUPS.map((group) => (
          <section key={group.label} className="admin-nav-group">
            <h2>{group.label}</h2>
            <ul>
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link href={item.href} aria-current={active ? "page" : undefined}>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
      <div className="admin-content">{children}</div>
    </div>
  );
}

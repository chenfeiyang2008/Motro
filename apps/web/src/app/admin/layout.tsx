"use client";

// 管理端外壳：标准后台侧栏，内容分组导航（当前只有“词条”入口已实现）。
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_GROUPS = [
  {
    label: "内容",
    items: [
      { href: "/admin/lexicon", label: "词条" },
      { href: "/admin/courses", label: "课程" },
    ],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
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

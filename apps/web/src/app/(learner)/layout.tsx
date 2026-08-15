"use client";

// 学习者外壳：移动端底部 Liquid Glass Dock，桌面端左贴边 Liquid Glass 侧栏。
// 专注学习页（/study/:id）隐藏全局导航，只保留该页最小专注 header；
// 结果页（/study/:id/result）恢复导航，主操作仍为“返回首页”。
// 导航只含现有真实路由（首页、课程）；排行榜/我的为后续阶段，不造空链接。
// 主题切换由根布局的全局按钮提供（登录页也可见）。
import Link from "next/link";
import { usePathname } from "next/navigation";

import { LiquidDock } from "./liquid-dock";

const NAV_ITEMS = [
  { href: "/", label: "首页", icon: "⌂" },
  { href: "/courses", label: "课程", icon: "▦" },
];

export default function LearnerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  // /study/<id> 正好一层段时是专注学习页；/study/<id>/result 是结果页（显示导航）。
  const isFocusedSession = /^\/study\/[^/]+$/.test(pathname);

  const chrome = (
    <div className="learner-chrome">
      <div className="learner-topbar glass-surface glass-surface--clear">
        <Link className="learner-brand learner-brand--mobile" href="/" aria-label="Motro 首页">
          <span className="learner-brand-mark" aria-hidden="true">
            M
          </span>
          <span className="learner-brand-name">Motro</span>
        </Link>
      </div>
      <LiquidDock pathname={pathname} />
      <nav className="learner-rail glass-surface glass-surface--regular" aria-label="学习者导航">
        <Link className="learner-brand" href="/" aria-label="Motro 首页">
          <span className="learner-brand-mark" aria-hidden="true">
            M
          </span>
          <span className="learner-brand-name">Motro</span>
        </Link>
        <div className="learner-nav">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}>
                <span className="learner-nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );

  return (
    <div className={`learner-layout${isFocusedSession ? " learner-layout--focused" : ""}`}>
      {!isFocusedSession && chrome}
      <div className="learner-content">{children}</div>
    </div>
  );
}

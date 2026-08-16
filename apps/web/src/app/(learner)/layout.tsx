"use client";

// 学习者外壳：移动端底部 Liquid Glass Dock，桌面端左贴边 Liquid Glass 侧栏。
// 专注学习页（/study/:id）隐藏全局导航，只保留该页最小专注 header；
// 结果页（/study/:id/result）恢复导航，主操作仍为“返回首页”。
// 主题切换由根布局的全局按钮提供（登录页也可见）。
import Link from "next/link";
import { usePathname } from "next/navigation";

import { LiquidDock } from "./liquid-dock";

const NAV_ITEMS = [
  { href: "/", label: "首页", icon: "home" },
  { href: "/courses", label: "课程", icon: "courses" },
  { href: "/xp", label: "经验", icon: "xp" },
  { href: "/leaderboard", label: "排行榜", icon: "leaderboard" },
];

const NAV_ICON: Record<(typeof NAV_ITEMS)[number]["icon"], React.ReactNode> = {
  home: (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3l9 5-9 5-9-5 9-5Z" />
      <path d="M5 10.5V15c0 1.1 3.1 2.5 7 2.5s7-1.4 7-2.5v-4.5" />
    </svg>
  ),
  courses: (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="4" width="17" height="14" rx="2" />
      <path d="M8 9h8M8 13h5" />
    </svg>
  ),
  xp: (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 19V5h13v14" />
      <path d="M4 12h5M9 12l2-3 3 4 2-2 2 1" />
      <path d="M4 8h5" />
    </svg>
  ),
  leaderboard: (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="9" y="3" width="6" height="6" />
      <rect x="3.5" y="11" width="6" height="9" />
      <rect x="14.5" y="11" width="6" height="9" />
    </svg>
  ),
};

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
                  {NAV_ICON[item.icon]}
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

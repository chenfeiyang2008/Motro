"use client";

// 管理端导航列表：侧栏和移动菜单共用同一组件。
// 每一项包含 SVG 图标 + 文字，选中态含左侧指示条 + 微弱背景 + font-weight。
import Link from "next/link";

import { ADMIN_ICONS } from "./icons";
import { isAdminPathActive, type AdminNavItem } from "./nav";

interface NavListProps {
  groups: Array<{ label: string; items: AdminNavItem[] }>;
  pathname: string;
  /** 点击导航项时的回调（移动菜单用于收起）。 */
  onNavigate?: () => void;
}

export function AdminNavList({ groups, pathname, onNavigate }: NavListProps) {
  return (
    <>
      {groups.map((group) => (
        <section key={group.label} className="admin-nav-group">
          <h2>{group.label}</h2>
          <ul>
            {group.items.map((item) => {
              const active = isAdminPathActive(pathname, item.href);
              const Icon = ADMIN_ICONS[item.icon];
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    {...(onNavigate ? { onClick: onNavigate } : {})}
                  >
                    <span className="admin-nav__icon" aria-hidden="true">
                      <Icon />
                    </span>
                    <span className="admin-nav__label">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

"use client";

// 管理端左侧栏：固定、贴边、带品牌标识 + 功能导航 + 顶栏主题切换。
// 不是漂浮圆角卡片（spec §4.3），桌面端始终可见；窄屏由 AdminMobileNav 接管。
// Liquid Glass 仅作用于侧栏功能层，正文/表单/表格保持实体表面。
import Link from "next/link";

import { MotroLogo } from "../motro-logo";
import { ADMIN_NAV_GROUPS } from "./nav";
import { AdminNavList } from "./nav-list";

interface Props {
  pathname: string;
}

export function AdminSidebar({ pathname }: Props) {
  return (
    <aside className="admin-sidebar" aria-label="管理端导航">
      <Link className="admin-brand" href="/admin" aria-label="Motro 管理端首页">
        <span className="admin-brand-mark" aria-hidden="true">
          <MotroLogo compact />
        </span>
        <span className="admin-brand-name">Motro</span>
      </Link>

      <div className="admin-nav">
        <AdminNavList groups={ADMIN_NAV_GROUPS} pathname={pathname} />
      </div>

      <div className="admin-sidebar__footer">
        <Link href="/" className="admin-sidebar__exit">
          前往学习端
        </Link>
      </div>
    </aside>
  );
}

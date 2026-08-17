// 管理端导航数据：按 UI spec §4.3 分组，只含已有真实路由。
// icon 字段为 ADMIN_ICONS 的键名，布局层负责渲染图标组件。
export interface AdminNavItem {
  href: string;
  label: string;
  icon: import("./icons").AdminIconName;
}

export const ADMIN_NAV_GROUPS: Array<{ label: string; items: AdminNavItem[] }> = [
  {
    label: "内容",
    items: [
      { href: "/admin/imports", label: "导入", icon: "import" },
      { href: "/admin/courses", label: "课程", icon: "courses" },
      { href: "/admin/lexicon", label: "词库", icon: "lexicon" },
      { href: "/admin/reviews", label: "审核", icon: "reviews" },
    ],
  },
  {
    label: "学习数据",
    items: [{ href: "/admin/xp", label: "经验", icon: "operations" }],
  },
  {
    label: "运维",
    items: [{ href: "/admin/operations", label: "任务状态", icon: "operations" }],
  },
  {
    label: "账号",
    items: [{ href: "/admin/users", label: "用户管理", icon: "users" }],
  },
];

// 管理端路由匹配：当前 pathname 精确匹配或前缀匹配时视为 active。
export function isAdminPathActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

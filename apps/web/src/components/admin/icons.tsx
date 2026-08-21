// 管理端功能图标集：与学习者端一致的几何描边风格（stroke 1.8，round cap/join）。
// 统一使用内联 SVG，禁止 emoji；选中态由调用方叠加填充/颜色，此处保持不变形。

interface IconProps {
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconImport(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3v12" />
      <path d="m8 11 4 4 4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

export function IconCourses(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3l9 5-9 5-9-5 9-5Z" />
      <path d="M5 10.5V15c0 1.1 3.1 2.5 7 2.5s7-1.4 7-2.5v-4.5" />
      <path d="M19 13v5" />
    </svg>
  );
}

export function IconLexicon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14.5A2.5 2.5 0 0 1 17.5 20H6.5A2.5 2.5 0 0 1 4 17.5v-12Z" />
      <path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20" />
      <path d="M8 7.5h7M8 11h5" />
    </svg>
  );
}

export function IconOperations(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M9 12h6M12 9v6" />
    </svg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M4 20c0-2.8 2.2-5 5-5s5 2.2 5 5" />
      <path d="M16 4.6A3.2 3.2 0 0 1 16 11.4" />
      <path d="M17.5 15.2c1.5.9 2.5 2.5 2.5 4.8" />
    </svg>
  );
}

export function IconCrown(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m4 7 4.2 4L12 6l3.8 5L20 7l-1.2 11H5.2L4 7Z" />
      <path d="M5.2 21h13.6" />
    </svg>
  );
}

export function IconReviews(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v13.5A2.5 2.5 0 0 1 17.5 19H6.5A2.5 2.5 0 0 1 4 16.5v-11Z" />
      <path d="M8 7h1.2M11.5 7H16" />
      <path d="M8 11h1.2M11.5 11H16" />
      <path d="m8.5 15 1 1 2-2" />
    </svg>
  );
}

export function IconMotivation(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5 14.1 9l5.9.4-4.5 3.8 1.4 5.8L12 16l-4.9 3 1.4-5.8L4 9.4 9.9 9 12 3.5Z" />
    </svg>
  );
}

export function IconDashboard(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.2" />
      <rect x="13.5" y="11.5" width="7" height="8" rx="1.2" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.2" />
    </svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

// 图标名 → 组件 的映射，供导航配置复用，避免在数据里 import 组件。
export const ADMIN_ICONS = {
  import: IconImport,
  courses: IconCourses,
  lexicon: IconLexicon,
  reviews: IconReviews,
  motivation: IconMotivation,
  operations: IconOperations,
  users: IconUsers,
  crown: IconCrown,
  dashboard: IconDashboard,
  menu: IconMenu,
  close: IconClose,
} as const;

export type AdminIconName = keyof typeof ADMIN_ICONS;

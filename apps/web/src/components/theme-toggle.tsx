"use client";

// 全局主题切换按钮（客户端组件，可被服务端根布局安全引用）。
import { useTheme } from "@/lib/theme";

export function ThemeToggleButton() {
  const { theme, toggle } = useTheme();
  const isLight = theme === "light";
  return (
    <button
      type="button"
      className="theme-toggle theme-toggle--global"
      aria-label={theme === "light" ? "切换到暗色主题" : "切换到亮色主题"}
      onClick={toggle}
    >
      <svg aria-hidden="true" className="theme-toggle__icon" viewBox="0 0 24 24" fill="none">
        {isLight ? (
          <path d="M20.4 15.1A8.5 8.5 0 0 1 8.9 3.6a8.5 8.5 0 1 0 11.5 11.5Z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="3.5" />
            <path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.72 5.28l-1.41 1.41M6.69 17.31l-1.41 1.41M18.72 18.72l-1.41-1.41M6.69 6.69 5.28 5.28" />
          </>
        )}
      </svg>
      <span className="visually-hidden">{isLight ? "切换到暗色主题" : "切换到亮色主题"}</span>
    </button>
  );
}

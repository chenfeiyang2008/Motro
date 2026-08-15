import type { Metadata } from "next";
import { ThemeProvider } from "@/lib/theme";
import { ThemeToggleButton } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Motro",
  description: "面向小规模受邀用户的英语词汇学习系统（平台基础阶段）",
};

/**
 * 内联脚本在首帧渲染前设置 data-theme，避免暗黑主题下的白屏闪烁（FOUC）。
 * 与 lib/theme.tsx 的 STORAGE_KEY 一致；仅设置属性，不执行其他逻辑。
 */
const themeInitScript = `(function(){try{var s=localStorage.getItem("motro.theme");var t=(s==="light"||s==="dark")?s:((window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          跳到主要内容
        </a>
        <ThemeProvider>
          <ThemeToggleButton />
          <main id="main">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}

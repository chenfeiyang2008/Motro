import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Motro",
  description: "面向小规模受邀用户的英语词汇学习系统（平台基础阶段）",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main">
          跳到主要内容
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}

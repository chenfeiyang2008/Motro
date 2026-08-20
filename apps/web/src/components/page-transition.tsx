"use client";

// 页面切换入场动效：用 pathname 作为 key 强制子内容在每次路由切换时重新挂载，
// 触发一次 ~500ms 的入场动画（opacity 淡入 + 小幅位移动效）。
//
// - 放在 layout 的 {children} 外层（learner + admin），覆盖所有子路由切换；
// - 仅 opacity（+ 极小 translateY ≤6px），不产生包含块/滚动偏移，丝滑不跳跃；
// - prefers-reduced-motion 下禁用动画（见 globals.css .page-enter）。
import { usePathname } from "next/navigation";

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="page-enter">
      {children}
    </div>
  );
}

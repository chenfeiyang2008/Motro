"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type DockItem = {
  href: string;
  label: string;
  icon: "home" | "courses" | "xp" | "leaderboard";
};

const DOCK_ITEMS: DockItem[] = [
  { href: "/", label: "首页", icon: "home" },
  { href: "/courses", label: "课程", icon: "courses" },
  { href: "/xp", label: "经验", icon: "xp" },
  { href: "/leaderboard", label: "排行榜", icon: "leaderboard" },
];

function DockIcon({ name }: { name: DockItem["icon"] }) {
  if (name === "home") {
    return (
      <svg aria-hidden="true" className="liquid-dock__icon" viewBox="0 0 24 24" fill="none">
        <path d="m3.5 10.5 8.5-7 8.5 7v9.25a.75.75 0 0 1-.75.75h-5.5v-6h-4.5v6h-5.5a.75.75 0 0 1-.75-.75V10.5Z" />
      </svg>
    );
  }
  if (name === "courses") {
    return (
      <svg aria-hidden="true" className="liquid-dock__icon" viewBox="0 0 24 24" fill="none">
        <rect x="4" y="3.5" width="16" height="17" rx="1.5" />
        <path d="M8 3.5v17M4 8h16M4 13h16M4 17h16" />
      </svg>
    );
  }
  if (name === "xp") {
    return (
      <svg aria-hidden="true" className="liquid-dock__icon" viewBox="0 0 24 24" fill="none">
        <path d="M4 19V5h13v14" />
        <path d="M4 12h5M9 12l2-3 3 4 2-2 2 1" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className="liquid-dock__icon" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="3" width="6" height="6" />
      <rect x="3.5" y="11" width="6" height="9" />
      <rect x="14.5" y="11" width="6" height="9" />
    </svg>
  );
}

export function LiquidDock({ pathname }: { pathname: string }) {
  const dockRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const navigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const livePathname = usePathname() ?? pathname;
  const [visualActiveIndex, setVisualActiveIndex] = useState(() =>
    Math.max(
      DOCK_ITEMS.findIndex(
        (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
      ),
      0,
    ),
  );

  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;

    const settle = () => {
      dock.style.setProperty("--dock-light-x", "50%");
      dock.style.setProperty("--dock-light-y", "-25%");
    };

    const onPointerMove = (event: PointerEvent) => {
      const bounds = dock.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100));
      const y = Math.max(-35, Math.min(125, ((event.clientY - bounds.top) / bounds.height) * 100));
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        dock.style.setProperty("--dock-light-x", `${x}%`);
        dock.style.setProperty("--dock-light-y", `${y}%`);
      });
    };

    dock.addEventListener("pointermove", onPointerMove);
    dock.addEventListener("pointerleave", settle);
    return () => {
      dock.removeEventListener("pointermove", onPointerMove);
      dock.removeEventListener("pointerleave", settle);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const activeIndex = DOCK_ITEMS.findIndex(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  const resolvedActiveIndex = Math.max(activeIndex, 0);

  // 路由变化时与服务端事实重新对齐；按下事件会先乐观更新，
  // 使连续点击能在同一条 transform transition 上平滑改道。
  useEffect(() => {
    setVisualActiveIndex(resolvedActiveIndex);
    if (navigationTimerRef.current !== null) {
      clearTimeout(navigationTimerRef.current);
      navigationTimerRef.current = null;
    }
  }, [resolvedActiveIndex]);

  useEffect(
    () => () => {
      if (navigationTimerRef.current !== null) clearTimeout(navigationTimerRef.current);
    },
    [],
  );

  const requestNavigation = (href: string, index: number) => {
    // 当前页不发第二个路由请求；快速连点时只提交最后一个目标。
    if (href === livePathname) return;
    setVisualActiveIndex(index);
    if (navigationTimerRef.current !== null) clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = setTimeout(() => {
      navigationTimerRef.current = null;
      router.push(href);
    }, 96);
  };

  return (
    <nav className="learner-dock" aria-label="学习者导航">
      <div
        ref={dockRef}
        className="liquid-dock"
        data-active-index={visualActiveIndex}
        data-liquid-glass="true"
      >
        <span className="liquid-dock__caustic" aria-hidden="true" />
        <div className="liquid-dock__content">
          <span className="liquid-dock__active-indicator" aria-hidden="true" />
          {DOCK_ITEMS.map((item, index) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  requestNavigation(item.href, index);
                }}
              >
                <DockIcon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

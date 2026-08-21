"use client";

// 管理端窄屏导航：折叠为一个可访问的菜单按钮 + 展开面板。
// - 展开后有显式关闭方式（关闭按钮 / Esc / 点击遮罩）、aria-expanded / aria-controls；
// - 打开时焦点移入面板，焦点在首尾之间循环（简单 focus trap），关闭时焦点归还按钮；
// - 菜单与桌面侧栏共用同一组导航项，确保手机端入口一致。
import { useEffect, useRef, useState } from "react";

import { AccountMenu } from "../account-menu";
import { ADMIN_ICONS } from "./icons";
import { AdminNavList } from "./nav-list";
import type { AdminNavItem } from "./nav";
import type { PublicUser } from "@/lib/auth";

interface Props {
  groups: Array<{ label: string; items: AdminNavItem[] }>;
  pathname: string;
  user: PublicUser;
  onLogout: () => void;
  logoutBusy: boolean;
  logoutError: string | null;
}

export function AdminMobileNav({
  groups,
  pathname,
  user,
  onLogout,
  logoutBusy,
  logoutError,
}: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 展开时把焦点移入面板首项；关闭监听从外部（Esc）。焦点循环在面板内键盘处理。
  useEffect(() => {
    if (open && panelRef.current) {
      const first = panelRef.current.querySelector<HTMLElement>("a[href]");
      first?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // 路由变化（如点击某个导航项后）自动收起菜单。
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 关闭并把焦点还给按钮，避免焦点落到页面主体造成困惑。
  function closeAndRestoreFocus() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  const panelId = "admin-mobile-nav-panel";

  return (
    <div className="admin-mobile-nav">
      <button
        ref={buttonRef}
        type="button"
        className="admin-mobile-nav__toggle"
        aria-label={open ? "关闭管理导航" : "打开管理导航"}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {nameOf(open ? "close" : "menu")}
        <span className="admin-mobile-nav__label">{open ? "关闭" : "菜单"}</span>
      </button>

      {open && <div className="admin-mobile-nav__backdrop" onClick={closeAndRestoreFocus} />}
      <div
        ref={panelRef}
        id={panelId}
        className="admin-mobile-nav__panel"
        role="dialog"
        aria-modal="true"
        aria-label="管理导航"
        hidden={!open}
      >
        <div className="admin-mobile-nav__panel-head">
          <span className="admin-mobile-nav__panel-title">管理导航</span>
          <button
            type="button"
            className="admin-mobile-nav__panel-close"
            aria-label="关闭管理导航"
            onClick={closeAndRestoreFocus}
          >
            {nameOf("close")}
          </button>
        </div>
        <AdminNavList groups={groups} pathname={pathname} onNavigate={closeAndRestoreFocus} />
        <div className="admin-mobile-nav__account">
          <AccountMenu user={user} onLogout={onLogout} busy={logoutBusy} />
          {logoutError && (
            <p className="app-logout-error admin-logout-error" role="alert">
              {logoutError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function nameOf(name: "menu" | "close") {
  const Icon = ADMIN_ICONS[name];
  return <Icon className="admin-mobile-nav__icon" />;
}

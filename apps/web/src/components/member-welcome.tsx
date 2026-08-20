"use client";

// 登录成功后的会员尊享欢迎层 —— 3D 尊贵会员卡 + 金闪开场 + 清晰生命周期。
// - 一次性：sessionStorage 信号消费后即标记为已展示；
// - React 定时器 + CSS animation 事件：动画结束后完全 unmount（不留 DOM 残留）；
// - prefers-reduced-motion：无位移/缩放/扫光，仅简短透明度切换；
// - pointer-events: none，不抢焦点、不阻挡 Tab/Esc/读屏。

import { useEffect, useState } from "react";
import "./member-welcome.css";
import { MemberCrownBadge } from "./member-crown-badge";

/** sessionStorage 信号：登录成功写入 1，欢迎层消费后立即删除 → 刷新不重复。 */
export const JUST_LOGGED_IN_MEMBER_KEY = "motro_just_logged_in_member";

/** 读取并消费"刚登录"信号。 */
export function consumeJustLoggedInSignal(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const v = sessionStorage.getItem(JUST_LOGGED_IN_MEMBER_KEY);
    if (v === "1") {
      sessionStorage.removeItem(JUST_LOGGED_IN_MEMBER_KEY);
      return true;
    }
  } catch {
    // sessionStorage 不可用 → 保守返回 false，不显示欢迎。
  }
  return false;
}

interface MemberWelcomeProps {
  /** 服务端确认的有效会员状态 */
  status?: string | undefined;
  /** 是否刚登录（由 consumeJustLoggedInSignal 提供） */
  justLoggedIn: boolean;
  /** 当前用户显示名（闪字用） */
  displayName?: string | undefined;
}

export function MemberWelcome({ status, justLoggedIn, displayName }: MemberWelcomeProps) {
  // 用 React 定时器完全卸载组件，确保所有 DOM（包括 ::after/::before 伪元素）消失。
  // 完整动画序列 ~1.8s（sweep→card flip→shine→flash）；卡面展示到 ~3.1s 后淡出，
  // ~3.7s 后 React unmount（遮罩、卡片、扫光一并消失，无残留）。
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!justLoggedIn || status !== "member") return;
    setVisible(true);
    // 停留 2100ms（完整序列 ≈ 1.2s 入场 + 2.1s 展示 + 0.78s 飞出）。
    const leaveTimer = setTimeout(() => setLeaving(true), 2100);
    // 离场：卡片飞出 800ms 后彻底 unmount（遮罩保持不透明直到 unmount）。
    const unmountTimer = setTimeout(() => setVisible(false), 2900);
    return () => {
      clearTimeout(leaveTimer);
      clearTimeout(unmountTimer);
    };
  }, [justLoggedIn, status]);

  if (!visible) return null;

  const name = (displayName ?? "").trim();
  const shortName = name.length > 10 ? `${name.slice(0, 10)}…` : name || "欢迎回来";

  return (
    <div
      className={`member-welcome-layer${leaving ? " member-welcome-layer--leaving" : ""}`}
      role="status"
      aria-live="polite"
    >
      {/* 金闪扫光条 */}
      <div className="member-sweep" aria-hidden="true" />
      {/* 3D 尊贵卡 */}
      <div className="member-card">
        <div className="member-card__shine" aria-hidden="true" />
        <div className="member-card__edge" aria-hidden="true" />
        {/* 右下四分之一处的淡品牌 M logo（尊贵水印） */}
        <div className="member-card__watermark" aria-hidden="true">
          M
        </div>

        <div className="member-card__top">
          <MemberCrownBadge status={status} size="welcome" />
          <span className="member-card__brand">MOTRO</span>
        </div>

        <div className="member-card__body">
          <span className="member-card__id-flash">{shortName}</span>
          <h2 className="member-card__title">尊享会员已就绪</h2>
          <p className="member-card__sub">今日学习不限时</p>
        </div>

        <div className="member-card__footer">
          <span className="member-card__chip">GOLD</span>
          <span className="member-card__no">#{Math.abs(name.length || 8)}</span>
        </div>
      </div>
    </div>
  );
}

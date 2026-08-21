"use client";

// 登录成功后的会员尊享欢迎层 —— 3D 尊贵会员卡 + 金闪开场 + 清晰生命周期。
// - 一次性：sessionStorage 信号消费后即标记为已展示；
// - React 定时器 + CSS animation 事件：动画结束后完全 unmount（不留 DOM 残留）；
// - prefers-reduced-motion：无位移/缩放/扫光，仅简短透明度切换；
// - pointer-events: none，不抢焦点、不阻挡 Tab/Esc/读屏。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
  // 进场前先提交稳定的预备帧，再在下一绘制帧开启 CSS 动画。
  // 这样动画不会与挂载、样式注入或 Strict Mode 的 effect 重放抢同一个 transform。
  const [visible, setVisible] = useState(false);
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!justLoggedIn || status !== "member") return;

    setVisible(true);
    setEntered(false);
    setLeaving(false);

    // 双 rAF 确保浏览器已画出 .member-card-stage 的预备姿态，避免首帧跳到终态。
    let enteredFrame: number | undefined;
    const enterFrame = requestAnimationFrame(() => {
      enteredFrame = requestAnimationFrame(() => setEntered(true));
    });
    const leaveTimer = setTimeout(() => setLeaving(true), 2600);
    // 离场为 320ms；稍后卸载以完整呈现向上飞出的尾段。
    const unmountTimer = setTimeout(() => setVisible(false), 2980);

    return () => {
      cancelAnimationFrame(enterFrame);
      if (enteredFrame !== undefined) cancelAnimationFrame(enteredFrame);
      clearTimeout(leaveTimer);
      clearTimeout(unmountTimer);
    };
  }, [justLoggedIn, status]);

  if (!visible) return null;

  const name = (displayName ?? "").trim();
  const shortName = name.length > 10 ? `${name.slice(0, 10)}…` : name || "欢迎回来";

  // 欢迎层必须脱离 PageTransition 的 DOM 子树：祖先动画中的 transform 会让
  // position: fixed 临时改以页面内容为 containing block，动画结束时再跳回视口。
  return createPortal(
    <div
      className={`member-welcome-layer${entered ? " member-welcome-layer--entered" : ""}${leaving ? " member-welcome-layer--leaving" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="member-card-stage">
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
    </div>,
    document.body,
  );
}

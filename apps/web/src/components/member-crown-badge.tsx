"use client";

// 学习端会员皇冠徽章（尊贵、克制）：用项目已有的几何描边皇冠图标，
// 不引入第三方图标库；浅/深主题自动适配品牌色对比度。
// 只在调用方确认"服务端返回有效会员"时渲染；本组件不自行取数、不伪造。

import { isEffectiveMember } from "@/lib/membership-display";
import "./member-crown-badge.css";

export type MemberCrownSize = "compact" | "default" | "welcome";

interface MemberCrownBadgeProps {
  /** 服务端会员状态字符串（来自 GET /me/membership 或 daily-usage） */
  status?: string | undefined;
  size?: MemberCrownSize;
  /** 是否显示"会员"文字标签（默认 true） */
  showLabel?: boolean;
  className?: string;
}

const SIZE_LABEL: Record<MemberCrownSize, string> = {
  compact: "会员",
  default: "会员",
  welcome: "尊享会员",
};

export function MemberCrownBadge({
  status,
  size = "compact",
  showLabel = true,
  className,
}: MemberCrownBadgeProps) {
  if (!isEffectiveMember(status)) return null;

  return (
    <span
      className={`member-crown-badge member-crown-badge--${size}${className ? ` ${className}` : ""}`}
      role="img"
      aria-label="会员"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
        <path
          d="m4 7 4.2 4L12 6l3.8 5L20 7l-1.2 11H5.2L4 7Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M5.2 20.5h13.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {showLabel && <span className="member-crown-badge__label">{SIZE_LABEL[size]}</span>}
    </span>
  );
}

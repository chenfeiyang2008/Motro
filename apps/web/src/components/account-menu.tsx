"use client";

// 统一账号/会员投影控件（学习端 + 管理端共用壳层）。
// - 会员徽章来自真实 GET /me/membership 契约（服务端计算），绝不客户端推导。
// - 提供明显、可访问的退出入口（调用真实 POST /auth/logout）；
//   退出失败由上层就地显示错误并允许重试，本组件不伪造“已退出”。
import { useEffect, useState } from "react";
import { fetchMeMembership, type MembershipInfo, type PublicUser } from "@/lib/auth";

interface AccountMenuProps {
  user: PublicUser;
  onLogout: () => void;
  busy: boolean;
}

export function AccountMenu({ user, onLogout, busy }: AccountMenuProps) {
  const [membership, setMembership] = useState<MembershipInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMeMembership().then((res) => {
      if (cancelled) return;
      if (res.ok && res.membership) setMembership(res.membership);
    });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const isMember = membership?.status === "member";
  const label = isMember ? "会员" : "免费";
  const badgeClass = isMember ? "account-badge account-badge--member" : "account-badge";

  return (
    <div className="account-menu" aria-label="账号">
      <div className="account-menu__identity">
        <span className="account-menu__name">{user.displayName}</span>
        <span className="account-menu__user">
          @{user.username} · {user.role === "admin" ? "管理员" : "学习者"}
        </span>
      </div>
      <span className={badgeClass} title={isMember ? "会员（服务端计算）" : "免费方案"}>
        {label}
      </span>
      <button type="button" className="account-menu__logout" onClick={onLogout} disabled={busy}>
        {busy ? "退出中…" : "退出登录"}
      </button>
    </div>
  );
}

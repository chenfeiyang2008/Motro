"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getDailyUsage, getMeXp, type DailyUsageSummary, type MeXp } from "@/lib/api";
import {
  fetchMe,
  fetchMeMembership,
  logout,
  type MembershipInfo,
  type PublicUser,
} from "@/lib/auth";
import { formatRankLabel, projectRankDisplay } from "@/lib/rank-display";
import { compactUuid, dailyUsageText, resetDayLabel } from "@/lib/membership-display";
import { MemberCrownBadge } from "@/components/member-crown-badge";

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [rank, setRank] = useState<MeXp | null>(null);
  const [membership, setMembership] = useState<MembershipInfo | null>(null);
  const [dailyUsage, setDailyUsage] = useState<DailyUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchMe(),
      getMeXp().catch(() => null),
      fetchMeMembership(),
      getDailyUsage(),
    ]).then(([me, xp, member, usage]) => {
      if (cancelled) return;
      if (
        me.status === 401 ||
        xp?.status === 401 ||
        member.status === 401 ||
        usage.status === 401
      ) {
        router.replace("/login");
        return;
      }
      if (me.user) setUser(me.user);
      if (xp?.data) setRank(xp.data);
      if (member.ok && member.membership) setMembership(member.membership);
      if (usage.ok && usage.data) setDailyUsage(usage.data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleLogout() {
    setLogoutBusy(true);
    setLogoutError(null);
    const result = await logout();
    setLogoutBusy(false);

    if (!result.ok) {
      setLogoutError(result.message ?? "退出失败，请重试。");
      return;
    }

    router.replace("/login");
  }

  if (loading) {
    return (
      <section className="profile-page" aria-busy="true">
        <div className="profile-skeleton" />
      </section>
    );
  }

  const rankDisplay = projectRankDisplay(rank);

  return (
    <section className="profile-page">
      <header className="profile-heading">
        <span className="xp-kicker">ACCOUNT</span>
        <h1>个人资料</h1>
      </header>
      <div className="profile-grid">
        <div className="profile-identity">
          <span className="profile-avatar" aria-hidden="true">
            {user?.displayName?.slice(0, 1) ?? "M"}
          </span>
          <div>
            <h2>{user?.displayName ?? "Motro 学习者"}</h2>
            <p>@{user?.username ?? "—"}</p>
          </div>
        </div>
        <dl className="profile-facts">
          <div>
            <dt>用户 ID</dt>
            <dd>
              <span className="profile-uuid" title={user?.id ?? ""}>
                {user?.id ? compactUuid(user.id) : "—"}
              </span>
            </dd>
          </div>
          <div>
            <dt>账户身份</dt>
            <dd>
              <span className="profile-badge">{user?.role === "admin" ? "管理员" : "学习者"}</span>
            </dd>
          </div>
          <div>
            <dt>会员身份</dt>
            <dd>
              <MemberCrownBadge status={membership?.status} size="default" />
              {membership?.status !== "member" && (
                <span className="profile-badge profile-badge--muted">免费方案</span>
              )}
            </dd>
          </div>
          <div>
            <dt>学习段位</dt>
            <dd>
              <span className="profile-badge profile-badge--rank">
                {formatRankLabel(rankDisplay)}
              </span>
            </dd>
          </div>
          {dailyUsage && (
            <>
              <div>
                <dt>今日已用</dt>
                <dd>{dailyUsage.usedMinutes ?? 0} 分钟</dd>
              </div>
              <div>
                <dt>学习权限</dt>
                <dd>{dailyUsageText(dailyUsage)}</dd>
              </div>
              {dailyUsage.resetDay && (
                <div>
                  <dt>重置时间</dt>
                  <dd>{resetDayLabel(dailyUsage.resetDay)}</dd>
                </div>
              )}
            </>
          )}
        </dl>
      </div>
      <Link href="/xp" className="profile-link">
        查看个人经验 →
      </Link>
      <section className="profile-account-actions" aria-labelledby="profile-account-actions-title">
        <div>
          <h2 id="profile-account-actions-title">账户操作</h2>
          <p>退出后需要重新登录才能继续学习。</p>
        </div>
        <button
          type="button"
          className="profile-logout"
          onClick={handleLogout}
          disabled={logoutBusy}
        >
          {logoutBusy ? "退出中…" : "退出登录"}
        </button>
      </section>
      {logoutError && (
        <p className="profile-logout-error" role="alert">
          {logoutError}
        </p>
      )}
    </section>
  );
}

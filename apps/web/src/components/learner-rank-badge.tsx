"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getMeXp, type MeXp } from "@/lib/api";
import { fetchMe } from "@/lib/auth";
import { projectRankDisplay } from "@/lib/rank-display";

export function LearnerRankBadge({ compact = false }: { compact?: boolean }) {
  const [rank, setRank] = useState<Pick<MeXp, "level" | "title"> | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const display = projectRankDisplay(rank);
  const level = Math.min(8, Math.max(1, display.level));

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getMeXp(), fetchMe()]).then(([xpResult, meResult]) => {
      if (cancelled) return;
      if (xpResult.ok && xpResult.data) {
        setRank({ level: xpResult.data.level, title: xpResult.data.title });
      }
      if (meResult.ok && meResult.user) setUserId(meResult.user.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Link
      className={`learner-rank-badge learner-rank-badge--level-${level}${compact ? " learner-rank-badge--compact" : ""}`}
      href="/profile"
      title={userId ? `用户 ID：${userId}` : "打开个人资料"}
      aria-label={`${display.title}，用户 ID ${userId ?? "同步中"}`}
    >
      <span className="learner-rank-badge__crest" aria-hidden="true">
        {level}
      </span>
      <span className="learner-rank-badge__meta">
        <span className="learner-rank-badge__title">
          Lv.{level} {display.title}
        </span>
        <span className="learner-rank-badge__id">
          {userId ? `ID ${userId.slice(0, 8)}…` : "ID 同步中"}
        </span>
      </span>
    </Link>
  );
}

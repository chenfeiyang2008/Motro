# Session Result

**Responsibility:** summarize the completed session and provide a calm exit.

**Primary action:** `返回首页`. `继续学习` appears as a secondary action only when the server reports eligible remaining work.

**Required content:** completed count, new-learning vs review/initial-review split, and a concise next-due message such as “下一次复习由系统按记忆状态安排。” Values reflect accepted server events for this one session, never a global/derived XP or streak claim. This stage shows completed/classified counts only — no XP, level, leaderboard or streak (XP/gamification is a later stage). Because no aggregate “session detail” API exists yet, the normal-completion path may keep a minimal display snapshot of the just-finished session (session id, started time, plan-item classification counts, completed count) in sessionStorage; a fresh load without that snapshot shows an honest “completed” state instead of fabricating statistics.

**Exclude:** full historical analytics, badge gallery, forced social sharing, oversized celebration, arbitrary performance grades, XP or streak figures.
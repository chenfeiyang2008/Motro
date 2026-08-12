# Session Result

**Responsibility:** summarize the completed session and provide a calm exit.

**Primary action:** `返回首页`. `继续学习` appears as a secondary action only when the server reports eligible remaining work.

**Required content:** completed count, new-learning vs review/initial-review split, and a concise next-due message such as “下一次复习由系统按记忆状态安排。” Values reflect accepted server events for this one session, never a global/derived XP or streak claim. This stage shows completed/classified counts only — no XP, level, leaderboard or streak (XP/gamification is a later stage). Because no aggregate “session detail” API exists yet, the normal-completion path may keep a minimal display snapshot of the just-finished session (session id, started time, plan-item classification counts, completed count) in sessionStorage; a fresh load without that snapshot shows an honest “completed” state instead of fabricating statistics.

## Motion choreography

- Completion uses one quiet, locally bounded `motion.context` transition: the final study decision resolves, the result summary occupies the same central stage and the primary exit action receives focus.
- Counts render at their accepted values; they never roll up from zero. A fact that truly changed during this session may receive one `motion.state` emphasis, but unchanged global metrics do not appear here.
- No confetti, fireworks, full-screen zoom, bouncing badge, looping glow or forced delay. A milestone such as a unit unlock is stated in text and may use one approved `motion.rare` change in its own small region.
- Reloading the result route does not replay completion. Reduced motion uses immediate replacement and the same focus/live-region semantics.

**Exclude:** full historical analytics, badge gallery, forced social sharing, oversized celebration, arbitrary performance grades, XP or streak figures.
# Learner Home

**Responsibility:** answer “What should I do today?” first, then “What progress have I actually made?” without turning the page into a generic analytics wall.

**Primary action:** `开始学习`, shown only when the plan has work. If complete, the strongest action becomes a quiet link to课程 rather than inventing extra practice.

**Required content:** today’s estimated minutes/card count, due/initial/new split, primary course and current unit, followed by the authoritative long-term metrics in [`../learner-dashboard-metrics.md`](../learner-dashboard-metrics.md). Loading reserves both plan and observatory geometry; partial failure keeps verified values, marks the unavailable region and offers retry.

## Confirmed visual direction — action-first learning cockpit

- Today’s plan remains the single visual centre of gravity: course/unit, estimated time, due/initial/new track and the sole `开始学习` button live in one opaque content stage. It is not Liquid Glass and is not nested inside another framed card.
- Express the plan as one continuous learning track rather than three metric cards. The track shows sequence and quantity through labels, numbers and position; color is supplemental.
- Below the plan, one coherent `学习进展` observatory presents `已稳定词汇` as the main cumulative fact, then the exposed → dual-initial-reviewed → stable maturity path, current-course progress, seven-day rhythm and due load. Streak appears only after stage 7 supplies its versioned server fact. Shared alignment and dividers create hierarchy; each value does not get its own floating card.
- `已稳定词汇` always carries the short definition “按双向卡预计间隔均达到 21 天计算，不代表永久掌握。” Current-course progress uses course items and current release; cross-course stable vocabulary uses globally deduplicated lexical entries.
- The level line shows a verified course label and position, such as `高中核心词汇 · 第 3 / 12 单元`, with `课程进度，不是能力测评`. Do not infer CEFR, IELTS, exam score or general ability from word counts, XP, streak, FSRS or completion.
- Seven-day rhythm may use seven zero-based bars or connected markers plus a visible sentence summary. Stable-word growth over 30/90 days belongs in a future detailed insight surface, not the home’s first view.
- The compact identity treatment is an avatar plus a plain display-name/profile affordance. Do not show a learner ID, membership tier or paid-status badge in learner chrome.
- The learner chrome is the only regular Liquid Glass layer: a bottom-safe-area-aware capsule Dock on compact layouts, a left-edge-attached side rail on desktop, and a compact header when the Dock is present. It is a single functional group over the page rather than a set of separate glossy buttons; content may pass beneath it on scroll while labels, selected state and focus remain legible. It uses an opaque high-contrast fallback for reduced transparency, increased contrast and unsupported backdrop effects.
- Brand character comes from editorial English typography, the continuous plan/maturity tracks and small language-derived background forms. Background forms are static, `aria-hidden`, very low contrast and never compete with data.

## Motion choreography

- Initial load resolves reserved geometry in place; totals do not count up from zero and metric blocks do not cascade into view.
- Pressing `开始学习` uses `motion.press`; accepted navigation may use `motion.context` to preserve focus continuity between the plan stage and study stage, but request dispatch and navigation never wait for animation.
- A just-completed session may update the relevant old fact to the new server fact using `motion.state`. Only changed marks move; the whole dashboard does not replay.
- A newly stable vocabulary fact or unit unlock may use one locally bounded `motion.rare` transition. Refreshing or revisiting the page never replays it.
- Reduced motion replaces spatial changes with immediate state plus optional short fade; all data and focus behavior remain identical.

## Responsive behavior

- At 390px, plan and primary action remain visible before long-term metrics; the observatory stacks as one continuous surface with no whole-page horizontal scroll.
- At 768px, plan remains first and the observatory may use two aligned columns without changing reading order.
- At 1440px, plan and a compact status rail may share the first composition, but the primary action remains dominant; additional width does not justify more metrics.
- The Dock never covers the plan CTA, chart summary or final observatory row; the desktop side rail remains attached to the left edge.

**Exclude:** course browsing, answer controls, detailed XP analytics on the first view, badge galleries, admin alerts, uncalibrated ability scores, circular “English ability” gauges and multiple “start” variants.

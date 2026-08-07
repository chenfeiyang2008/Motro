# Learner Home

**Responsibility:** answer “What should I do today?” and start the plan.

**Primary action:** `开始学习`, shown only when the plan has work. If complete, the strongest action becomes a quiet link to课程 rather than inventing extra practice.

**Required content:** today’s estimated minutes/card count, due review versus new-card split, primary course and current unit, streak status, and a compact weekly progress cue. Loading must reserve the plan region; error state offers retry.

**Confirmed visual direction — plan first:**

- Today’s plan is the single visual centre of gravity: course/unit, estimated time, due/new split and the sole `开始学习` button live in one solid content panel. The plan panel is not Liquid Glass and is not nested inside another framed card.
- Primary course, streak and weekly progress are supporting facts, not peer dashboard cards. Show the streak as a motivating consecutive-day record; show the weekly rhythm as connected circular day markers with text alternatives for assistive technology.
- The compact identity treatment is an avatar plus a member-tier icon and label. Do not show a learner ID in the learner chrome.
- The learner chrome is the only regular Liquid Glass layer: a bottom-safe-area-aware capsule Dock on compact layouts, a left-edge-attached side rail on desktop, and a compact header when the Dock is present. It is a single functional group over the page rather than a set of separate glossy buttons; content may pass beneath it on scroll while labels, selected state and focus remain legible. It uses an opaque high-contrast fallback for reduced transparency, increased contrast and unsupported backdrop effects.
- The title may use one restrained, interruptible text-entry microinteraction. It is optional content enhancement, never the only way to read the title, and must become static under reduced motion.

**Responsive behavior:** mobile stacks plan above supporting progress; desktop may place compact streak/course facts alongside the plan without turning them into equal cards. The Dock never covers the plan CTA or weekly cue; the desktop side rail remains attached to the left edge.

**Exclude:** course browsing, answer controls, detailed XP analytics, badge galleries, admin alerts and multiple “start” variants.

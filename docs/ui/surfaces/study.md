# Study Session

**Responsibility:** complete exactly one learning card decision at a time.

**Primary action:** before reveal, `显示答案`; after reveal, the four rating choices form one grouped decision with equal structural weight and clear labels.

**Required content:** minimal exit control, session progress, direction label, prompt, answer after reveal, optional course-approved hint, Again/Hard/Good/Easy and keyboard shortcuts. New items first show a learning face before each direction’s initial review.

**Confirmed visual direction — focused session:**

- Hide global learner navigation for the whole session. The only chrome is a compact regular Liquid Glass header containing exit/back and a textual, visible progress indicator with its progress bar.
- The central learning card is an opaque standard content surface, not Liquid Glass. It presents one direction, one prompt and one decision at a time; avoid decorative secondary cards and empty metric areas.
- Before reveal, use only `显示答案` as the primary action. After reveal, show Again / Hard / Good / Easy as one equally weighted, labeled group; color supports comprehension but never carries the rating alone.
- After a card transition, keyboard focus moves to the next available decision. `1`–`4` shortcuts remain available only for a revealed card, and reduced-motion/reduced-transparency settings preserve a legible, immediate state change.
- The header Glass has the same opaque fallback as home navigation. The learning surface and answer remain solid regardless of the navigation material.

**States:** loading/resume, front, revealed, submitting, recoverable submission error, session complete. A repeated idempotent response advances normally. Leaving while the current reveal is unsubmitted asks for confirmation; accepted events are already safe.

**Exclude:** global navigation, leaderboard, streak pressure, course editing, swipe-only controls, confetti and competing “skip” actions.

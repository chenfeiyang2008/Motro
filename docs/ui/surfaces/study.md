# Study Session

**Responsibility:** complete exactly one learning card decision at a time.

**Primary action:** before reveal, `显示答案`; after reveal, the four rating choices form one grouped decision with equal structural weight and clear labels.

**Required content:** minimal exit control, session progress, direction label, prompt, answer after reveal, optional course-approved hint, Again/Hard/Good/Easy and keyboard shortcuts. New items first show a learning face before each direction’s initial review.

**Confirmed visual direction — focused session:**

- Hide global learner navigation for the whole session. The only chrome is a compact regular Liquid Glass header containing exit/back and a textual, visible progress indicator with its progress bar. It is one functional group: the card may scroll or transition beneath it, but neither the progress text nor its keyboard focus state may rely on backdrop contrast alone.
- The central learning card is an opaque standard content surface, not Liquid Glass. It presents one direction, one prompt and one decision at a time; avoid decorative secondary cards and empty metric areas.
- Before reveal, use only `显示答案` as the primary action. After reveal, show Again / Hard / Good / Easy as one equally weighted, labeled group; color supports comprehension but never carries the rating alone.
- After a card transition, keyboard focus moves to the next available decision. `1`–`4` shortcuts remain available only for a revealed card, and reduced-motion/reduced-transparency settings preserve a legible, immediate state change.
- The header Glass has the same opaque fallback as home navigation. The learning surface and answer remain solid regardless of the navigation material.

## Motion choreography

- The prompt stage is the stationary frame of reference. Revealing an answer does not flip the whole card in 3D or move the header; the answer opens within the reserved answer region using `motion.state`, opacity and at most 6–8px vertical travel.
- Rating controls enter as one semantic group after the answer is available. A 20–30ms ordered reveal is permitted only when it preserves DOM/focus order and the group is fully usable immediately; otherwise all four appear together.
- Pressing a rating gives `motion.press` feedback at the chosen control. While the request is pending, controls remain geometrically stable and disabled with a textual submission state.
- After the server accepts the event, the current content uses a short same-axis exit and the next item enters from the corresponding origin within `motion.context`. Exit is slightly faster than entry. The next action becomes available without waiting for decorative completion.
- On network or server failure, the card stays in place; an inline recoverable error appears without shaking the card, changing the rating intention or generating a new idempotency key.
- Session progress updates from the previous accepted fact to the new accepted fact. It never advances optimistically beyond server authority and never animates a timer or count through intermediate false values.
- Reduced motion replaces reveal and card advance with immediate content replacement or a brief opacity change. Focus still lands on the same semantic target and live feedback announces the same result.

**States:** loading/resume, front, revealed, submitting, recoverable submission error, session complete. A repeated idempotent response advances normally. Leaving while the current reveal is unsubmitted asks for confirmation; accepted events are already safe.

**Exclude:** global navigation, leaderboard, streak pressure, course editing, swipe-only controls, confetti and competing “skip” actions.

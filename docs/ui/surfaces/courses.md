# Courses

**Responsibility:** browse published courses, understand unit structure and choose the primary course.

**Primary action:** on the selected course detail, `设为主课程` or a non-action selected state if already primary. Switching away from a current primary is a blocking confirmation that states other courses and their learning history are preserved; success uses a lightweight inline message.

**Required content:** course title/level/description, release freshness, unit order, locked/unlocked/completed state, learner progress and current primary marker. Course selection is explicit and preserves history. The list surfaces each course's own `已加入`/`主课程` badges from the `isEnrolled`/`isPrimary` response fields.

**Responsive behavior:** mobile uses a course list followed by a detail page; desktop may use master/detail if keyboard and URL navigation remain correct.

**Exclude:** live flashcards, rating, editing, import controls and game dashboards.

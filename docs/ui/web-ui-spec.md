# Motro Web UI Specification

## 1. Purpose and precedence

This document makes [`DESIGN.md`](../../DESIGN.md) implementable for the responsive learner and admin Web applications. `DESIGN.md` wins over this document; Motro documents win over external UI skills and framework defaults. Surface-specific requirements live in [`surfaces/`](surfaces/README.md).

## 2. Experience principles

1. **One job per page.** A learner should understand the page purpose and next action without scanning a dashboard.
2. **Learning before decoration.** Vocabulary, prompt, answer and progress have stronger hierarchy than XP, badges or streaks.
3. **Familiar controls.** Use conventional browser/app patterns and platform language; do not invent interaction primitives.
4. **Calm encouragement.** Feedback is immediate and warm but never noisy, shaming or casino-like.
5. **Progressive detail.** Show the decision now; put explanations, provenance and advanced settings one level deeper.

## 3. Design tokens

### 3.1 Color

| Semantic role | Light value | Usage |
| --- | --- | --- |
| `brand.600` | `#2F6FED` | Primary action, selected navigation, links |
| `brand.700` | `#255ED0` | Hover |
| `brand.800` | `#1F4FAF` | Pressed |
| `brand.050` | `#EAF1FF` | Selected/quiet brand background |
| `bg.page` | `#F7F9FC` | App canvas |
| `bg.surface` | `#FFFFFF` | Content surface and controls |
| `text.primary` | `#182230` | Headings and body |
| `text.secondary` | `#5D6B7A` | Supporting text |
| `border.default` | `#DCE3EC` | Dividers and component outlines |
| `status.success` | `#23875B` | Confirmed success and positive state |
| `status.warning` | `#C47A16` | Attention and recoverable risk |
| `status.error` | `#C84545` | Errors and destructive intent |

Every foreground/background pair must be verified for WCAG 2.2 AA. Semantic colors may use separately tested pale backgrounds; never lower opacity on text to create muted colors. Status is never conveyed by color alone.

### 3.2 Typography

- English learning content: self-hosted Lexend, weights 400/500/600, with `font-display: swap` and a system sans fallback.
- Chinese and general UI: `PingFang SC`, `Noto Sans SC`, `Microsoft YaHei`, system-ui, sans-serif.
- Base UI text: 16px/24px. Supporting text: 14px/20px. Do not use body text below 14px.
- Page title: 28px/36px on desktop, 24px/32px on mobile. Learning prompt may scale fluidly between 32px and 48px but must fit long words without clipping.
- Use sentence case. Avoid excessive bold; reserve 600 weight for headings, selected state and key values.
- Numbers affecting comparison (XP, rank, time) use tabular numerals where available.

### 3.3 Space, radius and elevation

- Base grid: 4px. Preferred steps: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Control radius: 8px. Content panel radius: 12px. Pills only for statuses or short filters.
- Default content max width: 1120px; study content max width: 720px; long text max width: 72 characters.
- Use whitespace and borders before shadows. Only overlays and clearly raised interactive surfaces may use a restrained shadow.
- Never nest framed panels solely to create hierarchy.

### 3.4 Iconography

Use one pinned Lucide version through the project wrapper. Default sizes are 16, 20 and 24px with consistent stroke width. Every icon-only control has an accessible name and tooltip where meaning is not universal. Do not use Emoji or AI-generated icons.

## 4. Layout and navigation

### 4.1 Breakpoints

- `< 600px`: compact mobile layout; bottom learner navigation; edge padding 16px.
- `600–1023px`: roomy mobile/tablet; bottom or compact top navigation based on content; edge padding 24px.
- `>= 1024px`: desktop; stable learner sidebar/top bar and admin sidebar; edge padding 32px.

Breakpoints respond to content rather than device names. Test required reference widths: 390px, 768px and 1440px.

### 4.2 Learner navigation

- Mobile bottom navigation has at most five destinations: 首页、课程、排行榜、我的; no empty fifth item.
- Desktop uses the same information architecture in a stable side rail or top bar. Active destination is indicated by label, icon and color—not color alone.
- Study sessions replace global navigation with a minimal header: exit/back, session progress and optional pause. Exiting with unsaved local interaction requires confirmation; accepted events never require confirmation.

### 4.3 Admin navigation

Use a standard left sidebar grouped as 内容（词条、导入、审核、课程、发布）, 用户, 运维（任务状态）. The current page title and breadcrumb identify location. Learner and admin applications use an explicit switch; admin tools never appear as learner dashboard widgets.

## 5. Components and interaction

### 5.1 Buttons and links

- One primary button per visible decision region. Secondary buttons are neutral; destructive actions are red only when intent is destructive.
- Button labels use verbs and objects: “开始学习”, “发布版本”, “重试失败行”. Avoid “确定” when a more exact label exists.
- Disabled controls explain prerequisites nearby; do not use a disabled button as the only error explanation.
- Links navigate; buttons perform actions. Do not style arbitrary containers as clickable.

### 5.2 Forms

- Labels remain visible; placeholders show examples, not labels.
- Validation appears beside the field after blur or submit, and the first invalid field receives focus on failed submission.
- Preserve user input after server errors. Mark required fields textually where ambiguity exists.
- Use native/selectable controls when sufficient. Searchable selects are reserved for genuinely long lists.

### 5.3 Feedback and overlays

- Inline message: validation, field-specific or recoverable content problem.
- Toast: non-critical success or background status; it must never be the sole location of necessary information.
- Drawer: supplemental editing while retaining list context, such as reviewing one import row.
- Dialog: irreversible or blocking confirmation, such as publishing a release or discarding unsaved edits.
- Full page: multi-step import mapping, course composition and account settings.
- Loading uses reserved layout and concise status. Use skeletons only when they mirror real content; never decorative skeleton walls.
- Empty states explain why the area is empty and offer one relevant next step. Errors include recovery when possible and a request ID for support.

### 5.4 Study card

- The “card” is the central learning object, not a decorative panel hierarchy.
- Front shows direction, prompt and one clear “显示答案” action. Back adds the answer and four rating buttons in order Again、Hard、Good、Easy with keyboard shortcuts 1–4.
- Rating controls remain unavailable until reveal. On submit, lock the controls, optimistically advance only when safe, and reconcile with server response without double submission.
- Do not use swipe as the only rating method. Do not encode rating solely by green/red; labels remain present.

### 5.5 Tables and dense admin data

Ant Design is allowed only in admin surfaces and must map to Motro tokens. Prefer tables for comparison-heavy data, with sticky header when useful, explicit sort state, pagination and an actions menu. On narrow screens, keep essential columns and move secondary detail into a drawer; do not convert every row into a decorative card.

## 6. Motion

- Duration range 120–220ms; easing should settle quickly without bounce.
- Use opacity and `transform` for reveal, row insertion and navigation state. Avoid parallax, looping decoration, confetti and large-scale page movement.
- Rating submission can use a short state confirmation; it must not delay the next card.
- Under `prefers-reduced-motion: reduce`, remove non-essential movement and keep immediate state changes.

## 7. Accessibility

- Semantic landmarks and headings have a logical hierarchy; every page has one `h1`.
- All actions are keyboard reachable in a predictable order. Focus is visible on all backgrounds and restored appropriately after drawers/dialogs close.
- Dialogs trap focus, have an accessible name, close by Escape when safe and return focus to the trigger.
- Dynamic study feedback uses restrained live regions; do not announce both toast and page content redundantly.
- Error summaries link to invalid fields. Tables include captions or programmatic labels and proper header associations.
- Minimum pointer target is 44×44 CSS px on mobile. Zoom to 200% must not hide actions or require two-dimensional scrolling except data tables.
- Support text resizing and long English words, Chinese translations and user names without truncating essential meaning.

## 8. Content style

Use direct, supportive Simplified Chinese. State what happened and what to do next. Avoid childish praise, guilt, artificial urgency and unexplained jargon. Examples:

- Good: “今天的计划已完成” / “还有 6 张到期卡” / “发布后将创建不可修改的版本 3”.
- Avoid: “太棒啦！！！你击败了所有人” / “赶快学习，不然连续记录就没了！” / “系统异常”.

English source content preserves spelling and source attribution. AI-generated Chinese must be visibly marked as draft in admin review, never in released learner content.

## 9. Visual and interaction review gate

For every key surface at 390/768/1440px:

1. Verify single job, single strongest action and correct navigation.
2. Check loading, empty, error, permission, long-content and destructive states.
3. Run keyboard-only and screen-reader spot checks; verify focus and reduced motion.
4. Run Impeccable `critique`, then `distill` or `quieter`, then `polish`, without enabling `live`, hooks, image generation or external agents.
5. Run Web Design Guidelines review and resolve findings or document intentional exceptions.
6. Update screenshot baselines only after a human accepts the intended visual change.

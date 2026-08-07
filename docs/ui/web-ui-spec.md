# Motro Web UI Specification

## 1. Purpose and precedence

This document makes [`DESIGN.md`](../../DESIGN.md) implementable for the responsive learner and admin Web applications. `DESIGN.md` wins over this document; Motro documents win over external UI skills and framework defaults. Surface-specific requirements live in [`surfaces/`](surfaces/README.md).

## 2. Experience principles

1. **One job per page.** A learner should understand the page purpose and next action without scanning a dashboard.
2. **Learning before decoration.** Vocabulary, prompt, answer and progress have stronger hierarchy than XP, badges or streaks.
3. **Familiar controls.** Use conventional browser/app patterns and platform language; do not invent interaction primitives. A weekly challenge board is separate from daily learning and ranks only server-graded challenge points.
4. **Calm encouragement.** Feedback is immediate and warm but never noisy, shaming or casino-like.
5. **Progressive detail.** Show the decision now; put explanations, provenance and advanced settings one level deeper.

## 3. Design tokens

### 3.1 Color

| Semantic role | Light value | Usage |
| --- | --- | --- |
| `brand.600` | `#F5781F` | Sole primary action, links |
| `brand.700` | `#E76812` | Hover |
| `brand.800` | `#DE640F` | Pressed |
| `brand.900` | `#B84D22` | Selected navigation text and icons on `brand.050` |
| `brand.050` | `#FFF2E8` | Selected/quiet brand background |
| `text.on-brand` | `#182230` | Text and icons on filled primary orange |
| `focus.default` | `#182230` | Visible focus indicator on light and filled-brand surfaces |
| `bg.page` | `#F7F9FC` | App canvas |
| `bg.surface` | `#FFFFFF` | Content surface and controls |
| `text.primary` | `#182230` | Headings and body |
| `text.secondary` | `#5D6B7A` | Supporting text |
| `border.default` | `#DCE3EC` | Dividers and component outlines |
| `status.success` | `#23875B` | Confirmed success and positive state |
| `status.warning` | `#C47A16` | Attention and recoverable risk |
| `status.error` | `#C84545` | Errors and destructive intent |

Every foreground/background pair must be verified for WCAG 2.2 AA. `text.on-brand` on `brand.600` is 5.79:1; `brand.900` on `brand.050` is 4.64:1. `focus.default` is a solid focus indicator with equivalent contrast on both the light canvas and filled-brand controls; it never depends on a reflection cue. Semantic colors may use separately tested pale backgrounds; never lower opacity on text to create muted colors. Status is never conveyed by color alone.

The bright orange brand is a controlled action and wayfinding accent, not a page decoration. Keep page/background/surface layers neutral, reserve filled orange for the one strongest action in a decision region, and use `brand.900` text/icons for selection on `brand.050`. Neutral secondary controls never become orange outlines. Do not create energy through broad saturated fills, gradient borders, glows, or a row of competing vivid status colors; hierarchy should first come from neutral surfaces, type and space. A soft color change is valid only when it comes from the real backdrop response of a Glass layer, never as decoration on a normal component. Components consume semantic role tokens, never these literal values, so a future dark or high-contrast theme can remap roles rather than mechanically invert this light palette.

**Confirmed dosage: A — bright emphasis.** Orange appears in the sole primary action, selected learner navigation, links, and limited high-value progress cues; it does not spread to ordinary secondary controls or semantic status messages.

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

### 3.4 Liquid Glass material

Liquid Glass is a functional navigation/control layer, not a translucent treatment for all surfaces. It follows the product-level rules in [`DESIGN.md`](../../DESIGN.md#liquid-glass-材质), which take precedence.

- **Allocate the layers before styling.** The content layer contains plans, facts, course copy, forms and learning cards, and uses the standard opaque surface. The functional foreground layer contains navigation and direct contextual controls, and is where Glass is encouraged. Content may scroll and remain perceptible beneath a Glass region, but the foreground labels must stay legible in both resting and scrolling states.
- Use **regular Glass** by default for the mobile learner Dock, desktop learner sidebar, app/study headers, compact toolbars, popovers and text-dense functional groups. It must adapt to the luminance of the actual backdrop through a translucent fill and adequate blur, plus a subtle edge and restrained elevation. A fixed translucent color alone is not a valid regular Glass treatment.
- Use **clear Glass** only above visually rich media. The learner's ordinary light canvas, study cards, course copy, forms, plans and fact panels use standard opaque content surfaces instead. Clear Glass requires a tested dimming layer when the underlying content is bright (use a roughly 35% dark layer as the starting point, then verify contrast).
- Keep one coherent Glass group per navigation region. Related destinations or contextual controls share that group and spacing; do not turn every card, metric, list row or secondary button into Glass, and do not layer Glass panels inside Glass panels. A content-layer slider or toggle may briefly adopt Glass while directly manipulated, but returns to the standard content layer otherwise.
- Brand color is reserved for one primary action background and selected navigation labels/icons. Do not tint several Glass controls with bright orange at once.
- Provide an opaque `bg.surface` fallback for browsers without `backdrop-filter`, `prefers-reduced-transparency: reduce`, and `prefers-contrast: more`. The fallback preserves the same labels, selected state, focus ring, layout and 44px target sizes; never make muted text by reducing its opacity.
- Test Glass against the resting and scrolling content under it, including the most colorful permitted course content. Never accept a material solely because it looks correct on an empty canvas.

### 3.5 Glass optical rendering

For Web, reproduce the **functional hierarchy and perceptual cues**, not Apple platform compositor internals. A valid regular Glass region is composed in this order: (1) actual backdrop participation, with blur only where supported; (2) an adaptive translucent base that preserves label contrast; (3) a subtle inner/outer edge that distinguishes the boundary; and (4) a restrained elevation shadow. These cues together express the optical behavior Apple describes as background refraction, reflected ambient color/light, and edge lensing.

- **Specify thickness as a stack, not a number.** The upper/outer edge is a restrained light-catching rim; the lower/inner edge is a slightly darker occlusion cue; the shadow has a real offset and soft blur. Together they make the functional layer read as a single piece of glass above the content. Do not add multiple white borders, a zero-offset glow, or a large blur radius to make Glass feel thicker.
- **Keep edge optics local.** A weak background-only refraction/lensing cue may exist immediately around the contour, never through labels, icons, focus rings, or hit targets. Larger text-dense Glass regions such as the rail and Dock gain readability by using a more opaque regular base, not by adding a heavier outline. In opaque fallback, replace all optical edges with one tested `border.default`-equivalent boundary.
- **Refraction is background-only.** A softly altered backdrop may appear to bend at the outer boundary, but text, icons, focus indicators and hit targets in the functional layer must never distort, move, or lose contrast. Do not simulate a lens by applying filters or transforms to the control content.
- **Reflection is contextual, not decoration.** A faint reflected light/color response may react to actual backdrop changes or to a direct hover/press interaction. It must remain low contrast, be absent when it harms readability, and never appear as a persistent white shine, rainbow sheen, or autonomous sweep. A static CSS gradient is not sufficient evidence of Liquid Glass.
- **Edge treatment is a boundary, not an outline style.** Use one quiet rim that communicates separation from content; avoid doubled strokes, glowing blue borders, and a separate glossy tile around every destination. The opaque fallback keeps an equivalent boundary using the standard border token.
- **No browser-costly imitation.** Do not animate `filter`, `backdrop-filter`, or a large full-screen blur on every pointer or scroll frame. Limit simultaneous Glass regions, keep the Dock/rail/header as one group, and animate only composited state properties when possible. If the material cannot remain responsive on a target device, retain the semantic grouping with the opaque fallback.

### 3.6 Glass component states

- A Glass control exposes real `default`, `hover` (pointer-capable devices only), `focus-visible`, `pressed`, `selected`, and `disabled` states. The focus indication must be independently visible; do not use a brighter Glass rim as the only keyboard-focus cue.
- Selected navigation combines brand color with a semantic label/icon state or visible indicator. The selected state must remain identifiable in the opaque fallback and without color perception.
- Keep labels and icons in tested high-contrast foreground colors. Do not choose a material or label color just because it looks right over one screenshot; the background and accessibility preferences can alter material appearance.
- In a compact toolbar, use conventional controls and concentric radii relative to the containing Glass region. Do not approximate an Apple control by adding extra glossy outlines, ornamental highlights, or competing colored buttons.
- Glass may morph subtly during a user-initiated control activation or navigation selection. Within one related group, a selected item may continuously reshape into its destination or expand into its contextual menu; unrelated controls never melt together. The transition must be 120–220ms, interruptible, and removed under reduced motion; it must never delay an action or become a looping effect.
- Press feedback is shorter than a navigation transition and does not bounce. It may slightly change the material's perceived depth or edge response, but must preserve the control's layout, pointer target, label baseline and keyboard focus location.
- Test motion at normal scrolling speed and repeated keyboard selection. It must not stutter, trigger repeated layout shifts, or leave a partially morphed state when an interaction is interrupted.

### 3.7 Iconography

Use the pinned Motro Icon Set through the project wrapper: a fixed Lucide geometric base with explicitly curated, same-concept filled, enclosed, or optically heavier variants. Do not import a second icon library, use Emoji, or use AI-generated icons.

- **Default is not always a thin outline.** Use outline variants for ordinary toolbar, list, and text-adjacent actions. Use the curated same-concept filled, enclosed, or optically heavier treatment for selected global navigation, completion/attention states, and the member-tier mark when it improves recognition. The selected treatment is a semantic state, not a general decoration; it must preserve the same concept and optical footprint as the default. Do not manufacture a variant by arbitrarily filling an outline SVG in CSS.
- **Sizes and weights:** 16px is for dense metadata and must not have an effective stroke below 1.75px; 20px is the standard UI icon; 24px is reserved for direct emphasis. Match icon weight to adjacent text, using a fuller visual weight beside 600 selected labels. Adjust optical padding for circles, narrow symbols, and badges when needed; do not rely solely on equal SVG boxes.
- **Color and layers:** default to one tested foreground color. A meaningful multi-part symbol may use primary/secondary opacity layers or one brand-orange emphasis layer with neutral structure, but never generic rainbow fills, glass effects inside an icon, or decorative gradients. Text and icons in one control use the same semantic foreground role.
- Every icon-only control has an accessible name and a tooltip where its meaning is not universal. Its target is at least 44px on touch devices, and focus/selected/disabled states remain identifiable without color alone.

## 4. Layout and navigation

### 4.1 Breakpoints

- `< 600px`: compact mobile layout; bottom learner navigation; edge padding 16px.
- `600–1023px`: roomy mobile/tablet; bottom or compact top navigation based on content; edge padding 24px.
- `>= 1024px`: desktop; stable learner sidebar/top bar and admin sidebar; edge padding 32px.

Breakpoints respond to content rather than device names. Test required reference widths: 390px, 768px and 1440px.

### 4.2 Learner navigation

- Mobile bottom navigation has at most five destinations: 首页、课程、排行榜、我的; no empty fifth item. It may be a bottom-safe-area-aware, capsule-shaped Liquid Glass Dock when it is one coherent navigation group rather than a floating action button.
- Desktop uses the same information architecture in a stable, left-edge-attached Liquid Glass side rail or top bar. It remains one continuous regular Glass group, rather than a rounded panel floating within the page. Active destination is indicated by label, icon and color—not color alone.
- Study sessions replace global navigation with a minimal header: exit/back, session progress and optional pause. Challenge quizzes use the same focus pattern with exit, `n / 10` and an accessible five-minute countdown. Exiting with unsaved local interaction requires confirmation; accepted events never require confirmation.

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
- The card uses the standard opaque content surface, even when its surrounding navigation uses Liquid Glass.
- Front shows direction, prompt and one clear “显示答案” action. Back adds the answer and four rating buttons in order Again、Hard、Good、Easy with keyboard shortcuts 1–4.
- Rating controls remain unavailable until reveal. On submit, lock the controls, optimistically advance only when safe, and reconcile with server response without double submission.
- Do not use swipe as the only rating method. Do not encode rating solely by green/red; labels remain present.

### 5.5 Tables and dense admin data

Ant Design is allowed only in admin surfaces and must map to Motro tokens. Prefer tables for comparison-heavy data, with sticky header when useful, explicit sort state, pagination and an actions menu. On narrow screens, keep essential columns and move secondary detail into a drawer; do not convert every row into a decorative card.

## 6. Motion

- Duration range 120–220ms; easing should settle quickly without bounce.
- Use opacity and `transform` for reveal, row insertion and navigation state. Avoid parallax, looping decoration, confetti and large-scale page movement.
- Rating submission can use a short state confirmation; it must not delay the next card. Quiz feedback is immediate and inline; never award speed points or obscure whether a question was score-eligible.
- Under `prefers-reduced-motion: reduce`, remove non-essential movement and keep immediate state changes.
- Under `prefers-reduced-transparency: reduce`, `prefers-contrast: more`, or missing backdrop support, replace Glass with opaque surfaces; never merely lower text opacity or remove an edge.
- A scroll edge may increase functional separation of a Glass header or Dock when content passes behind it, but it must not obscure progress, mutate layout, or create a decorative animated gradient.
- For an eligible Glass group, use one continuous navigation-selection or contextual-menu transition rather than several independent fades. Keep press feedback shorter than selection motion; do not animate backdrop filters continuously to manufacture smoothness.

## 7. Accessibility

- Semantic landmarks and headings have a logical hierarchy; every page has one `h1` and a visible-on-focus “skip to main content” link. Heading anchors reserve scroll space below fixed Glass chrome.
- All actions are keyboard reachable in a predictable order. Use native buttons for actions and links for navigation; do not turn generic containers into click targets. Focus is visible through `:focus-visible` on all backgrounds, never removed without an equivalent replacement, and restored appropriately after drawers/dialogs close.
- Dialogs trap focus, have an accessible name, close by Escape when safe and return focus to the trigger.
- Dynamic study feedback uses restrained live regions; do not announce both toast and page content redundantly.
- Error summaries link to invalid fields. Tables include captions or programmatic labels and proper header associations.
- Minimum pointer target is 44×44 CSS px on mobile. Zoom to 200% must not hide actions or require two-dimensional scrolling except data tables.
- Touch controls use `touch-action: manipulation`; set the webkit tap highlight deliberately instead of relying on a browser default that conflicts with the material. Full-bleed Dock and header layouts account for `env(safe-area-inset-*)`.
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
6. For every Glass region, test resting and scrolling backgrounds (including the strongest permitted content color), unsupported-backdrop fallback, reduced transparency and increased contrast; verify labels, focus rings, selected states, pointer/keyboard states and target sizes remain AA-compliant. Confirm that any reflection/refraction cue is background-only, low-contrast, and absent when the fallback is active.
7. Test representative direct interactions at normal scroll speed and with repeated keyboard activation. Verify that Glass transitions are interruptible, do not cause layout shifts or dropped frames, and fully reduce to immediate state changes when motion is reduced.
8. Update screenshot baselines only after a human accepts the intended visual change.

# Motro 动效与学习仪表盘基准研究

> 研究日期：2026-08-11
> 范围：Apple、Google、W3C 与 Council of Europe 的一手资料。本文是研究依据，不直接覆盖 `DESIGN.md` 或产品规则；其中“来源事实”与“Motro 推论”严格分开。

## 1. 结论摘要

Motro 的高级感不应来自更多动画，而应来自一套可预测的运动逻辑：动作发生在哪里、状态如何改变、下一步从哪里出现，界面都给出短促、连贯且可中断的反馈。高频学习操作使用安静的标准动效；只有开始会话、词项达到稳定、单元解锁等少数关键时刻才使用更有表现力的“标志性动效”。动效不能延迟下一张卡，也不能依靠弹跳、扫光、持续漂浮或大范围模糊制造存在感。

学习者首页可以比“毛坯式极简”展示更多信息，但不应退化为等权统计卡片墙。建议采用一个有层级的“学习驾驶舱”：今日行动是主任务；已稳定词汇、当前课程进度、记忆负担与近期节奏构成次级状态；更细的数据进入“学习洞察”页面。所有指标必须能追溯到服务器事实，并用准确名称解释口径。

“掌握词汇总量”可以展示，但产品正式术语应是“已稳定词汇”，并说明它表示 Motro 中一个全局词条的两个方向预计间隔均达到 21 天，不等同于永久掌握。CEFR A1–C2 是多维沟通能力描述，不能从词数直接换算。Motro 在没有经过验证的 CEFR 对齐内容和多技能测评前，只能显示“词汇覆盖参考”，不得显示“你的英语能力是 B1”之类的结论。

## 2. 官方资料中的共同原则

### 2.1 Apple：动效服务于理解、反馈与连续性

**来源事实**

- Apple Human Interface Guidelines 将 motion 的用途归纳为传达状态、提供反馈与指导，并明确要求有目的地使用动效，避免无意义或过量动画。[Apple HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- Apple 建议反馈动画简短而精确；高频交互通常不应增加需要用户反复关注的额外动画；尽可能让用户取消或打断动效，不应要求用户等动画播完才能继续操作。[Apple HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- Apple 认为自然动画有助于保留上下文，但“delight”不能变成装饰，更不能妨碍产品的核心目的；简洁也不等同于视觉上的极少主义。[Apple HIG: Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)
- Apple 对 Reduce Motion 的建议不仅是“全部关闭”：如果动画表达了状态变化或层级关系，可以改为 dissolve、highlight fade 或 color shift，保留含义并减少空间运动。[Apple: Reduced Motion evaluation criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/reduced-motion-evaluation-criteria)
- Apple 的可访问性指引建议在 Reduce Motion 下减少自动、重复、缩放、深度和周边运动，收紧弹簧效果，并可用淡入淡出替代 x/y/z 轴移动，避免在 blur 之间做动画。[Apple HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)

**适用于 Motro 的推论**

- 学习评分是高频操作，动效必须轻：按下反馈、答案接受、当前卡离场与下一卡进入可以形成连续动作，但服务器成功后不应等待“演完”才允许继续。
- 动效的第一职责是解释“发生了什么”，例如评分已接受、计划游标已前进、单元刚解锁；不能用彩纸、弹跳和扫光代替事实反馈。
- reduced-motion 不是删除所有反馈。Motro 应保留即时文本、颜色以外的状态标记和轻微透明度变化，只移除显著位移、缩放、弹性和深度运动。

### 2.2 Apple Liquid Glass：动态材质属于功能层

**来源事实**

- Apple 将 Liquid Glass 定义为位于内容之上的独立功能层，主要承载导航与控件；内容层应使用标准材质。Apple 明确反对在内容层滥用 Glass，也反对 Glass 叠 Glass。[Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- regular Glass 会依据背景调节模糊和亮度以维持可读性；clear Glass 适用于媒体丰富的背景，并可能需要暗化层。Apple 要求材质响应降低透明度、提高对比度等系统设置。[Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- Apple 对 Liquid Glass 的说明把视觉与运动视为一个整体：交互时材质提供直接反馈，相关控件可在上下文变化时连续变形，但仍强调 Glass 适合导航层、应谨慎使用，并应响应 Reduced Transparency、Increased Contrast 和 Reduced Motion。[WWDC25: Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)

**适用于 Motro 的推论**

- Motro 可将移动 Dock、桌面侧栏、学习页最小工具栏做成一个连续 regular Glass 群组；学习卡、仪表数据、图表、表格和课程内容保持不透明。
- 高级材质不等于持续动画滤镜。Glass 的背景模糊应是静态或低频状态响应；交互只改变边缘、阴影、透明度和极小位移，不逐帧动画 `backdrop-filter`。
- 相关导航选中态可以共享几何连续性；无关按钮不能相互“融化”。Web 只能借鉴功能层级和感知线索，不应假装复制 Apple 私有合成器。

### 2.3 Google：表现力必须提高可用性，而不是破坏熟悉模式

**来源事实**

- Google 对 Material 3 Expressive 的研究把颜色、形状、尺寸、运动与 containment 视为提高表现力和可用性的手段；其研究强调用这些手段突出关键动作、分组相关元素。[Google Design: Expressive Design research](https://design.google/library/expressive-material-design-google-research)
- Google 同一研究明确指出表现力不是通用答案：破坏熟悉列表模式或移除文字标签会降低可用性；应从用户需求出发，优先核心功能、遵守无障碍规范并持续测试迭代。[Google Design: Expressive Design research](https://design.google/library/expressive-material-design-google-research)
- Material 3 的 `MotionScheme` 将 standard motion 定位于功利性组件和重复交互，将 expressive motion 定位于突出的 UI 元素与 hero interaction，并区分改变形状/边界的 spatial motion 与颜色、透明度等非空间 effects motion。[Android Developers: MotionScheme](https://developer.android.com/reference/kotlin/androidx/compose/material3/MotionScheme)
- Google 的高性能 Web 动画指南建议优先使用 `transform` 和 `opacity`，避免触发布局或绘制的属性；模糊与阴影等绘制可能更昂贵，应通过开发者工具验证。[web.dev: High-performance CSS animations](https://web.dev/articles/animations-guide)
- Chrome Lighthouse 指出非合成动画在低端手机或主线程繁忙时容易卡顿，并可能导致布局偏移；其审计可定位未被合成的动画。[Chrome for Developers: Avoid non-composited animations](https://developer.chrome.com/docs/lighthouse/performance/non-composited-animations)

**适用于 Motro 的推论**

- Motro 应建立两级 motion scheme：高频、功利性交互使用 standard；仅在“开始学习”“已稳定词汇增加”“单元解锁”等稀有事件使用 expressive。
- 表现力应来自重点元素的尺度、排版、形状与连续性，而不是给所有组件加颜色和动画。熟悉的按钮、表格、列表、标签与文字不能为了“新潮”被替换。
- 所有关键动画应以 `transform` 和 `opacity` 为主；不连续动画宽高、位置、全屏 blur 或 `backdrop-filter`。确需形变时，先证明不会造成布局位移和掉帧。

### 2.4 W3C：运动必须可控，数据不能只靠颜色表达

**来源事实**

- WCAG 2.2 的 Animation from Interactions 要求用户能够禁用由交互触发的非必要 motion animation；W3C 特别指出视差滚动等运动可能引发眩晕、恶心和头痛，并列出 `prefers-reduced-motion` 作为技术路径。[W3C Understanding SC 2.3.3](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions)
- 对自动开始且持续超过五秒、与其他内容并行显示的运动、闪烁或滚动内容，WCAG 2.2 要求提供暂停、停止或隐藏机制（除非运动是必要的）。[W3C Understanding SC 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
- WCAG 要求颜色不能成为传达信息、状态或区分数据的唯一方式。[W3C Understanding SC 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color)
- W3C 对复杂图表建议同时提供简短说明和完整文本等价物，文本应表达关键值、关系和趋势；降低图表的不必要复杂度也能帮助更多人理解。[W3C WAI: Complex Images](https://www.w3.org/WAI/tutorials/images/complex/)

**适用于 Motro 的推论**

- Motro 禁止循环漂浮、自动滚动数字、无限脉冲和持续高光。若未来存在自动更新趋势图，视觉变化必须能暂停，或改成用户刷新后一次性更新。
- 仪表图中的“稳定／学习中／待复习”必须同时使用文字、数值和形状/纹理，不以橙、绿、灰三种颜色作为唯一编码。
- 每个趋势图旁必须有一句自然语言摘要和可访问的数据表/列表入口；核心数值直接存在于 HTML，不藏在 SVG、Canvas 或 hover tooltip 中。

## 3. Motro 动效系统建议

以下属于 **Motro 的设计决策建议**，不是 Apple 或 Google 的原文。

### 3.1 动效分级

| 层级 | 使用场景 | 建议表现 | 禁止 |
| --- | --- | --- | --- |
| 即时反馈 | 按钮按下、评分选中、开关、字段校验 | 120–160ms；透明度、轻微缩放或位移；立即响应输入 | 弹跳、延迟请求、改变布局 |
| 标准状态 | 翻出答案、列表插入、导航选中、卡片前进 | 160–220ms；同一轴向和同一来源；可随时中断 | 3D 翻牌、跨屏飞行、多元素乱序入场 |
| 结构过渡 | 首页计划进入会话、工具栏展开、结果页出现 | 180–260ms；只有真实共享几何才连续变形 | 为了演示材质而延长流程 |
| 标志时刻 | 首个稳定词汇、单元解锁、阶段目标完成 | 260–320ms；一次局部强调；不阻塞后续操作 | 彩纸、烟花、全屏震动、持续光效 |

正式决策以 `DESIGN.md` 为准：高频反馈通常为 80–220ms，只有低频且具备真实空间意义的上下文或标志时刻可使用 220–320ms，并必须有 reduced-motion 等价状态；时长本身不是高级感。

### 3.2 动效语法

- **进入使用减速，退出使用较快收束。** 新状态应快速建立、平稳停下；离开状态不抢占注意力。
- **方向表达关系。** 同级学习卡沿同一短轴替换；进入子层时由触发点或容器展开；返回时反向收束。没有空间关系就使用淡变，不随意横飞。
- **一次动作只有一个焦点。** 评分后，按钮反馈与卡片前进属于同一节奏；导航、背景和指标不同时表演。
- **数值从旧事实过渡到新事实。** 首次加载直接显示服务器精确值，不从 0 数起；只有服务器接受新事件后，相关数字才从旧值过渡到新值。
- **可中断、可重入、可恢复。** 快速连续点击、路由中断、网络失败或后台恢复不能让界面停在半完成形态；动效结束不是业务提交条件。
- **不动画昂贵材质。** Glass 模糊半径保持稳定，不随指针或滚动逐帧变化；需要反馈时只变换合成友好的边缘伪元素、透明度和 transform。

### 3.3 关键流程的标志性动效

#### 首页进入学习

今日计划的主按钮被确认后，计划内容在原位置轻微收束，学习会话内容以一致焦点出现。不要让整张首页卡片飞入学习页，也不要等待转场后才发请求。加载超过短暂阈值时，显示稳定的结构占位与文本状态。

#### 显示答案

答案在词卡内部获得空间，提示与答案发生局部重新编排；不使用夸张 3D 翻转。评分区只在答案可见后进入，顺序与键盘焦点保持稳定。

#### 提交评分与下一张卡

评分按钮先提供即时按压/接受反馈；服务端成功后当前内容短距离退出、下一张从同一空间关系进入。失败时卡片留在原位，错误就地出现；重试沿用同一幂等意图。

#### 已稳定词汇增加

只有当服务器事实使某个全局词条首次满足 Motro 的稳定口径时，数字才做一次局部更新：旧数字与新数字短交叉淡变，可伴随不超过一行高度的向上移动。页面加载、刷新和切换标签时不重复庆祝。

#### 单元解锁

课程路径中的锁定节点原位转换为已解锁节点，连接轨道同时更新，说明文字明确“为什么解锁”。效果局限于路径区域；不覆盖页面、不播放彩纸、不抢走用户当前任务。

### 3.4 Reduced motion 等价方案

在 `prefers-reduced-motion: reduce` 下：

- 删除视差、显著缩放、弹性、z 轴、长距离移动、背景图案运动；
- 卡片前进改为即时替换或 80–120ms 透明度变化；
- 单元解锁改为静态图标/文字状态和一次非移动高亮；
- 数值直接更新，并用 `aria-live="polite"` 在必要时播报事实；
- 保留焦点、选中、成功、错误等完整语义，不因移除动效丢失状态；
- 同时验证 `prefers-reduced-transparency`、`prefers-contrast: more` 与 Glass 的实色回退。

### 3.5 性能与验收

- 目标浏览器的常规动效按流畅 60Hz 显示设计；性能验收关注持续帧时间和掉帧，不把“设置了 60fps”当作保证。
- 使用 Chrome DevTools Performance、Paint flashing 与 Lighthouse non-composited animation 检查；关键流程还需在 WebKit 验证。
- 默认只动画 `transform` 与 `opacity`；其他属性需要书面理由和实机证据。
- 动效期间不得产生可见 CLS；文本基线、点击区域和键盘焦点位置保持稳定。
- 在 390px、768px、1440px，以及低性能设备/CPU throttling 下验证首页、学习、结果和课程解锁。
- Playwright 至少断言最终状态、焦点与 reduced-motion 行为；截图回归只在人工接受预期视觉变化后更新。

## 4. 学习者仪表盘的信息架构

### 4.1 页面目标

首页仍然首先回答“我现在应该做什么”，但可以同时回答三个次级问题：

1. 我的词汇记忆积累到了哪里？
2. 当前课程离下一阶段还有多远？
3. 最近学习节奏和复习负担是否健康？

这不是把四个问题做成四张等权卡片。建议采用一个视觉连续的“今日学习驾驶舱”：左/上方是今日计划和唯一主操作，右/下方是可扫读的学习状态带；详细趋势通过“查看学习洞察”进入独立页面。

### 4.2 首页首屏建议

#### 主区域：今日学习轨道

- 主课程与当前单元；
- 到期复习、首复习、新学习三个阶段的真实候选数；
- 预计分钟数；
- 唯一主操作“开始学习／继续学习”；
- 计划完成后转为安静完成态，不发明额外训练。

视觉上使用一条连续任务轨道，而不是三张统计卡；移动端纵向，桌面端横向。轨道状态同时用文字、数字和形状表达。

#### 次区域：学习状态带

建议首页直接显示以下 4 项，形成一个整体排版区，而不是四个独立卡片：

| 指标 | 首页标签 | 口径 | 为什么有用 |
| --- | --- | --- | --- |
| 稳定词汇 | `已稳定词汇` | 对当前用户按 `lexical_entry_id` 去重；至少一个已学课程词项的两个方向预计间隔均 ≥21 天 | 表达长期积累，避免跨课程重复词虚增 |
| 当前课程 | `本课程已稳定` | 主课程 current release 内已稳定课程词项 / 全部课程词项 | 连接长期记忆与眼前课程 |
| 近期节奏 | `本周学习` | 按用户时区有有效学习事实的天数与已接受复习事件；不把打开页面算学习 | 显示节奏，不用羞辱式连续天数文案 |
| 复习负担 | `待复习` | 当前到期卡数量；可进一步显示最久逾期时间，但不制造“健康分” | 帮助用户决定今天是否需要学习 |

可选第五项是“完成双向首测词汇”，但只放在洞察页，避免与“已稳定词汇”产生两个竞争总量。

### 4.3 高级视觉表达

- **主数字使用编辑式排版。** `1,284` 是页面的身份性数字，标签明确为“已稳定词汇”；旁边用一句话解释本周净增加，而不是单独再做增长卡。
- **课程进度使用分段轨道。** 单元节点与当前所在位置结合，不使用速度表式 gauge；未解锁、首测中、稳定三种状态同时有形状与文字。
- **近期节奏使用 7 日微型图。** 一周七个可读节点展示是否有有效学习，附“本周 5 天”文本；不使用无限滚动热力图占据首页。
- **趋势图只在洞察页。** 30/90 天的稳定词汇变化使用折线或阶梯线，并提供自然语言摘要与数据表。首次渲染不从 0 生长，更新时只从旧数据平滑到新数据。
- **品牌橘只强调现在的动作。** 数据的层级主要由字号、位置、粗细和留白形成；状态色只表达状态，不把每个指标涂成鲜艳颜色。
- **背景有深度但不喧宾夺主。** 可使用近乎不可察觉的语言排版纹理或大字母轮廓作为页面背景；必须 `aria-hidden`、不运动、不降低文字对比。内容事实使用不透明面，导航层才使用 Glass。

### 4.4 学习洞察页建议

首页保持行动优先，新增独立“学习洞察”页承载比较和解释：

- 已稳定词汇及 30/90 天净变化；
- 新学习、双向首测完成、已稳定三段漏斗；
- 主课程按单元的首测/稳定进度；
- 到期与逾期复习分布；
- 学习天数和有效复习事件趋势；
- 词汇覆盖参考（满足第 5 节条件后才出现）；
- 每项指标的口径说明、更新时间和可访问数据表。

不要展示单一“学习健康分”“记忆力 92 分”或无法解释的综合百分比。这类合成分数很现代，但会隐藏权重、制造伪精确，也无法指导用户下一步。

## 5. “等价能力级别”的诚实边界

### 5.1 Council of Europe 的定义

**来源事实**

- Council of Europe 将 CEFR A1–C2 定义为通过 “can-do” descriptors 描述的语言熟练度，覆盖听、读、口语互动、口语表达和写作等活动，而不是一个词数分段表。[Council of Europe: CEFR Levels](https://www.coe.int/en/web/common-european-framework-reference-languages/level-descriptions)；[CEFR Self-assessment grid](https://www.coe.int/en/web/common-european-framework-reference-languages/table-%202-cefr-3.3-common-reference-levels-self-assessment-grid)
- CEFR 的框架还包含交际语境、任务、策略与多种语言能力；Council of Europe 明确说 CEFR 不只是 proficiency scales。[Council of Europe: The framework](https://www.coe.int/en/web/common-european-framework-reference-languages/introduction-and-context)
- CEFR Companion Volume 的 vocabulary range 描述使用“基础词语库”“熟悉主题的良好词汇范围”“广泛词汇库”等质性表达，而不是为每一级规定固定词数。[CEFR Companion Volume 2020](https://rm.coe.int/cefr-companion-volume-with-new-descriptors-2020/16809ea0d4)
- 针对具体语言的 Reference Level Descriptions 可以把词汇、语法等形式映射到 CEFR 层级，但这些描述由不同国家/团队以不同方法制作，并非 Council of Europe 自己制定的通用词数换算表。[Council of Europe: Reference Level Descriptions](https://www.coe.int/en/web/common-european-framework-reference-languages/reference-level-descriptions)
- Council of Europe 说明其不负责验证考试或文凭与 CEFR 层级之间的对齐质量；具体评估需要相应机构保证质量与公平。[Council of Europe: The framework](https://www.coe.int/en/web/common-european-framework-reference-languages/introduction-and-context)

### 5.2 Motro 可以显示什么

#### 现在可以显示

- `已稳定词汇 1,284`；
- `本课程已稳定 38%`；
- `A2 词汇覆盖参考 72%`，**仅在课程词项拥有可追溯的英语 Reference Level Description 映射时**；
- 固定说明：“仅表示 Motro 中已稳定词汇对该参考词表的覆盖，不代表听说读写综合 CEFR 等级。”

#### 现在不能显示

- `你的英语水平：B1`；
- `1,500 词 = CEFR B1`；
- `超过 80% 即达到 A2`，除非存在经批准、版本化并验证过的映射和阈值；
- `相当于雅思 5.5／高考 120 分`；
- 把 FSRS stability、XP、连续天数、答题活动量或挑战积分换算成语言能力。

### 5.3 将来如何获得可信的能力级别

如果未来要显示“综合能力参考”，必须先完成独立产品与测量设计：

1. 使用有明确许可、版本和来源的 CEFR 英语 Reference Level Description 内容映射；
2. 分开测量词汇理解、词汇产出、语法、阅读、听力、写作与口语中实际覆盖的维度；
3. 使用标准化题目、难度校准和足够样本验证阈值；
4. 公开显示评估日期、覆盖技能、置信范围和限制；
5. 展示多维 profile，而不是把所有能力压成单一等级；
6. 在未经外部验证前始终称为 `Motro 能力参考`，不得称为 CEFR 认证或官方成绩。

因此，近期仪表的可行方案是把该区域命名为 **“词汇覆盖参考”**。没有可靠映射时显示“暂不可估算”，并解释需要先完成带等级来源的课程内容；诚实的空状态优于伪造一个看似高级的数字。

## 6. 数据准确性与可访问性规则

以下均为 Motro 实施规则：

- 所有指标由服务器派生，响应包含 `asOf`、规则/映射版本和统计范围；客户端不自行估算主数字。
- `已稳定词汇` 按全局词条去重；`本课程已稳定` 按课程词项统计。两个指标不可互换。
- 当前 release 是课程分母；历史移除词项可保留学习事实，但不能继续占当前课程进度分母。
- 同时展示计数与分母，例如 `48 / 120`，避免只显示百分比。
- 趋势变化必须给出比较期间，例如“过去 30 天 +86”，不能使用无时间窗口的上升箭头。
- 统计为 0、暂无数据、计算中和服务失败是四种不同状态，不能都渲染成 `—`。
- 图形信息同时提供可见文本摘要；详细数据可通过语义表格读取。颜色从不单独表达状态。
- 动画前后的精确数字始终可访问；读屏不逐帧播报中间值，只在最终事实变化后礼貌播报一次。
- 排行榜挑战积分、成长 XP、连续天数与词汇稳定指标保持不同语义，不能在一个“总能力”分数中合并。

## 7. 反模式清单

- 页面加载时所有数字从 0 滚动到真实值；
- 每个统计块都悬浮、发光、玻璃化或拥有独立入场动画；
- 循环呼吸的主按钮、无限渐变边框、鼠标追光和滚动视差；
- 大面积布局移动、3D 翻卡、弹簧过冲或卡片被甩出屏幕；
- 动画中改变宽高、网格轨道、`top/left`、大阴影或 `backdrop-filter`；
- 用绿色环形 gauge 暗示“英语能力 78%”；
- 用 XP、连续天数、复习次数或课程完成率冒充语言能力；
- 用单词总量直接换算 CEFR、IELTS、高考或“超过多少母语者”；
- 为追求表现力移除文字标签、改变熟悉导航或制造陌生手势；
- reduced-motion 下直接删除状态反馈，或只把持续时间缩短而保留眩晕性的缩放/位移。

## 8. 后续规范落地建议

本研究建议由主任务选择性合并到以下正式文件：

- `DESIGN.md`：补充“表现力不是装饰”、standard/expressive motion 分级与能力数据诚实原则；
- `docs/ui/web-ui-spec.md`：补充 motion tokens、性能门禁、仪表图可访问性与 reduced-motion 等价规则；
- `docs/ui/surfaces/home.md`：把首页从紧凑事实区升级为“今日学习驾驶舱”，明确 4 个首页指标；
- 新建学习洞察 surface：承载趋势、课程进度和词汇覆盖参考；
- `CONTEXT.md`：如产品批准，新增“已稳定词汇总量”“词汇覆盖参考”，并明确它们不等同于综合语言能力。

在正式实现前，应先做 390px、768px、1440px 的真实数据原型，至少包含：新用户、数据稀少、正常积累、复习积压、课程切换和 reduced-motion 六类状态。原型评审应先检查数据是否诚实、主任务是否清楚，再评估视觉表现力。

## 9. 一手资料索引

- [Apple HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple HIG: Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)
- [Apple: Reduced Motion evaluation criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/reduced-motion-evaluation-criteria)
- [WWDC25: Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)
- [Google Design: Expressive Design research](https://design.google/library/expressive-material-design-google-research)
- [Google Design: Making Motion Meaningful](https://design.google/library/making-motion-meaningful)
- [Android Developers: MotionScheme](https://developer.android.com/reference/kotlin/androidx/compose/material3/MotionScheme)
- [web.dev: High-performance CSS animations](https://web.dev/articles/animations-guide)
- [Chrome for Developers: Avoid non-composited animations](https://developer.chrome.com/docs/lighthouse/performance/non-composited-animations)
- [Google Cloud: Selecting an effective data visualization](https://docs.cloud.google.com/looker/docs/visualization-guide)
- [W3C Understanding SC 2.3.3](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions)
- [W3C Understanding SC 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html)
- [W3C Understanding SC 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color)
- [W3C WAI: Complex Images](https://www.w3.org/WAI/tutorials/images/complex/)
- [Council of Europe: CEFR Levels](https://www.coe.int/en/web/common-european-framework-reference-languages/level-descriptions)
- [Council of Europe: CEFR Self-assessment grid](https://www.coe.int/en/web/common-european-framework-reference-languages/table-%202-cefr-3.3-common-reference-levels-self-assessment-grid)
- [Council of Europe: The CEFR framework](https://www.coe.int/en/web/common-european-framework-reference-languages/introduction-and-context)
- [Council of Europe: Reference Level Descriptions](https://www.coe.int/en/web/common-european-framework-reference-languages/reference-level-descriptions)
- [CEFR Companion Volume 2020](https://rm.coe.int/cefr-companion-volume-with-new-descriptors-2020/16809ea0d4)

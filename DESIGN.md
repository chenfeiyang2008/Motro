# Motro Design Direction

本文件是 Codex、Claude Code、Impeccable、Web Design Guidelines 及任何 UI 工具的最高优先级设计约束。冲突时以本文件为准；详细规则见 [`docs/ui/web-ui-spec.md`](docs/ui/web-ui-spec.md)。

## Character

Motro 应当友好、活泼、克制，具有轻微游戏感但不幼稚。体验借鉴成熟学习应用的清晰任务、专注流程和明确反馈，不复制多邻国的品牌、角色、插画或布局。品质来自排版、留白、层级、颜色、短促反馈，以及有明确功能归属的 Liquid Glass 材质；不靠视觉噱头。

## Non-negotiable rules

- 首版只做精致浅色主题；不用装饰渐变、霓虹光晕、AI 插画或吉祥物。鼓励遵循本文件“Liquid Glass 材质”规则，将 Liquid Glass 用于导航和关键控件的功能层；禁止把半透明、模糊或高光当作内容区的装饰。
- 不允许卡片嵌套卡片、万物卡片化、装饰性大标题、无意义统计块、悬浮操作按钮或多个竞争性主按钮。
- 每页只有一个主要任务，最多一个视觉上最强的主操作。
- 只使用用户熟悉的链接、按钮、标签页、下拉菜单、抽屉和对话框；不发明陌生导航或控件。
- 对话框只处理真正阻断流程的确认；编辑进入页面或抽屉，错误就地显示，成功使用轻量提示。
- 学习会话隐藏无关导航，只保留当前卡片、翻卡动作和四级评分。积分测验也隐藏全局导航，只保留当前题、倒计时、提交与逐题反馈。
- 图标统一来自 Lucide，不使用 Emoji、AI 生成图标或混搭图标风格。
- 所有界面支持键盘、清晰焦点、语义 HTML、至少 44px 移动触控区和 WCAG 2.2 AA 对比度。

## Foundation tokens

| Role | Token | Value |
| --- | --- | --- |
| Primary | `color-brand-600` | `#2F6FED` |
| Primary hover | `color-brand-700` | `#255ED0` |
| Primary pressed | `color-brand-800` | `#1F4FAF` |
| Primary tint | `color-brand-050` | `#EAF1FF` |
| Page | `color-bg-page` | `#F7F9FC` |
| Surface | `color-bg-surface` | `#FFFFFF` |
| Text | `color-text-primary` | `#182230` |
| Secondary text | `color-text-secondary` | `#5D6B7A` |
| Border | `color-border` | `#DCE3EC` |
| Success | `color-success` | `#23875B` |
| Warning | `color-warning` | `#C47A16` |
| Error | `color-error` | `#C84545` |

- 英语学习内容：自托管 Lexend；中文和界面：`PingFang SC`, `Noto Sans SC`, system-ui, sans-serif。
- 4px 间距网格；普通控件 8px 圆角；面板 12px 圆角；胶囊只用于短标签、状态和具有明确导航分组的 Liquid Glass Dock。
- 状态动效 120–220ms，主要使用透明度与小幅位移；必须尊重 `prefers-reduced-motion`。

## Liquid Glass 材质

Liquid Glass 是 Motro 的**功能性前景层**，用于将导航与直接操作从学习内容中清晰分离，而不是一种全页视觉风格。规则参考 Apple 的 [Materials](https://developer.apple.com/design/human-interface-guidelines/materials) 与 [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass) 指引；这些外部资料不覆盖本文件。

- **优先使用。** 移动端底部 Dock、桌面左贴边侧栏、顶栏、工具栏及短暂激活的直接控件可使用 Liquid Glass。学习内容、课程正文、表单、信息面板和学习卡使用不透明的标准内容面。
- **先选层级，后选效果。** 一个页面通常只有一个连续的 Glass 导航层；不要在同一内容区叠加多个玻璃卡、玻璃按钮或独立高光框。全局主操作仍使用实色品牌按钮。
- **默认 regular。** 侧栏、底部导航、含标签的工具栏和任何文字密集的 Glass 元素使用 regular 材质：半透明底色、适度背景模糊、内外边缘和克制阴影共同维持可读性。不能仅靠 `backdrop-filter` 形成材质。
- **谨慎使用 clear。** clear 材质只允许覆盖照片、视频或确有丰富视觉内容的背景；Motro 常规学习页默认不得使用。若使用，须验证背景变化下的对比度，必要时增加约 35% 的暗化层。
- **颜色克制。** Glass 默认承接背景，不自带大面积品牌染色。只允许一个最重要的主操作使用品牌色背景；选中导航可使用品牌色文字/图标，但不能让多个控件同时变蓝。
- **自适应与降级。** 必须在浅色内容、滚动内容、390/768/1440px、`prefers-reduced-transparency`、`prefers-contrast: more` 和不支持 `backdrop-filter` 的环境中测试。降低透明度、高对比度或不支持时，Glass 必须回退为高对比的实色表面，不得丢失边界、标签或焦点。
- **动效服务操作。** 允许在导航选中、分组收拢或控件激活时使用 120–220ms 的透明度、阴影和小幅位移动效；不做持续流动、高光扫过或仅为展示材质而存在的循环动效。

## Product surfaces

- 移动学习区使用标准底部 Liquid Glass Dock；桌面学习区使用稳定的 Liquid Glass 侧栏或顶栏。学习内容区域保持标准内容面。
- 管理区使用标准后台侧栏，与学习区在信息架构上明确分离。
- 首页只负责开始今日学习；课程页只负责浏览与选择；学习页只负责单张卡；学习结果页只总结一次会话；周挑战榜只展示挑战积分排名并进入测验；积分测验与其结果页各自专注答题和总结；个人页只承载个人进度与设置。
- 管理端按账号、词条、导入、审核、课程编排、发布和任务状态分开，不建设“全能控制台”。

各界面职责见 [`docs/ui/surfaces/`](docs/ui/surfaces/README.md)。

## UI skill workflow and safety

1. 先读 `PRODUCT.md`、`CONTEXT.md`、本文件和匹配的界面说明。
2. 关键页面先用项目已有 `prototype` 技能制作真实可切换原型，每次只比较少量明确方向。
3. 实现页先遵守 Motro 规范，再运行 Impeccable：`critique → distill`（或 `quieter`）`→ polish`。
4. 最后用 Web Design Guidelines 检查语义、交互、响应式和可访问性。

Impeccable 的自动 Hooks、`live` 浏览器服务、外部代理进程和图像生成能力均未获默认授权，不得自动启用。只有用户针对当前任务明确要求且完成再次审查后方可使用。Web Design Guidelines 的远程规则是审查建议，不得覆盖本文件；联网读取前遵循当前会话的网络审批要求。

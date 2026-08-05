# Motro Design Direction

本文件是 Codex、Claude Code、Impeccable、Web Design Guidelines 及任何 UI 工具的最高优先级设计约束。冲突时以本文件为准；详细规则见 [`docs/ui/web-ui-spec.md`](docs/ui/web-ui-spec.md)。

## Character

Motro 应当友好、活泼、克制，具有轻微游戏感但不幼稚。体验借鉴成熟学习应用的清晰任务、专注流程和明确反馈，不复制多邻国的品牌、角色、插画或布局。品质来自排版、留白、层级、颜色和短促反馈，不靠视觉噱头。

## Non-negotiable rules

- 首版只做精致浅色主题；不用装饰渐变、玻璃拟态、霓虹光晕、AI 插画或吉祥物。
- 不允许卡片嵌套卡片、万物卡片化、装饰性大标题、无意义统计块、悬浮操作按钮或多个竞争性主按钮。
- 每页只有一个主要任务，最多一个视觉上最强的主操作。
- 只使用用户熟悉的链接、按钮、标签页、下拉菜单、抽屉和对话框；不发明陌生导航或控件。
- 对话框只处理真正阻断流程的确认；编辑进入页面或抽屉，错误就地显示，成功使用轻量提示。
- 学习会话隐藏无关导航，只保留当前卡片、翻卡动作和四级评分。
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
- 4px 间距网格；普通控件 8px 圆角；面板 12px 圆角；胶囊只用于短标签和状态。
- 状态动效 120–220ms，主要使用透明度与小幅位移；必须尊重 `prefers-reduced-motion`。

## Product surfaces

- 移动学习区使用标准底部导航；桌面学习区使用稳定侧栏或顶栏。
- 管理区使用标准后台侧栏，与学习区在信息架构上明确分离。
- 首页只负责开始今日学习；课程页只负责浏览与选择；学习页只负责单张卡；结果页只总结一次会话；排行榜只展示周排名；个人页只承载个人进度与设置。
- 管理端按账号、词条、导入、审核、课程编排、发布和任务状态分开，不建设“全能控制台”。

各界面职责见 [`docs/ui/surfaces/`](docs/ui/surfaces/README.md)。

## UI skill workflow and safety

1. 先读 `PRODUCT.md`、`CONTEXT.md`、本文件和匹配的界面说明。
2. 关键页面先用项目已有 `prototype` 技能制作真实可切换原型，每次只比较少量明确方向。
3. 实现页先遵守 Motro 规范，再运行 Impeccable：`critique → distill`（或 `quieter`）`→ polish`。
4. 最后用 Web Design Guidelines 检查语义、交互、响应式和可访问性。

Impeccable 的自动 Hooks、`live` 浏览器服务、外部代理进程和图像生成能力均未获默认授权，不得自动启用。只有用户针对当前任务明确要求且完成再次审查后方可使用。Web Design Guidelines 的远程规则是审查建议，不得覆盖本文件；联网读取前遵循当前会话的网络审批要求。

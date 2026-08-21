# 安全策略（Security Policy）

## 项目定位

Motro 是一个面向小规模受邀用户的英语词汇学习系统，部署在家庭服务器或局域网内网，仅限受邀用户通过 Web 访问。它**不是一个面向公网、开放注册的产品**：没有开放注册入口，没有公网 DNS 暴露（家庭服务器形态经 Tailscale 提供点对点 HTTPS，内网形态由运维自行追加 Caddy 反向代理）。因此，按设计本品**不存在公网攻击面**。

## 漏洞披露

这是一个个人项目，暂无专职安全团队。如你发现任何安全相关问题，请**私下**报告，不要公开 Issue：

- 通过 **GitHub Security Advisory** 私信报告；或
- 邮件至 **motro@example.com**。

我们会在合理时间内确认并修复，并在修复后公开致谢（如你愿意）。

## 密钥与配置

- **所有密钥（数据库口令、session/CSRF key、第三方 provider 凭据等）均在部署时注入，绝不提交到仓库。** 仓库内的 `.env` 与 `.env.example` 仅含占位与说明。
- 安全相关配置集中在 [`compose/intranet.yml`](compose/intranet.yml)，敏感变量一律使用 `${VAR:?}` 形式——**缺失即失败（fail-fast）**，避免误以空值或默认值启动。
- 部署前请运行 `pnpm config:check` 校验配置完整性。

## 外部网络与 Provider

- 内容管线的 Wiktionary 与 DeepSeek 适配器均提供 **fake（仅本地模拟）默认模式**：默认情况下**不会发起真实的外部网络请求**，除非在部署配置中显式启用 real provider 模式。
- 启用真实网络访问（real provider）时，请遵循 [`docs/deployment/lan-real-provider.md`](docs/deployment/lan-real-provider.md)，并确认网络边界与凭据受控。

## 适用范围

本策略仅覆盖 Motro 仓库自身代码与官方部署文档。第三方依赖的安全问题请向其上游维护者报告。

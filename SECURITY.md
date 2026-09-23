# 安全政策

## 支持的版本

| 版本 | 是否支持 |
|---|---|
| 0.1.x（`main` 最新） | ✅ |
| < 0.1.0 | ❌（预发布版本，请升级） |

## 报告漏洞

**疑似漏洞不要开公开 issue。**
发邮件到 `leaves615@gmail.com`，写清：

- 插件版本和 DSH 版本、
- 你做了什么、期望什么、实际发生什么、
- host 日志片段（`llm-ctl:` 开头的行），密钥先脱敏。

72 小时内回复，在 `main` 上修复；release notes 里致谢（不想具名请说明）。

## 本插件如何处理密钥

- **从不问你要密钥。** provider 的 credential 存在 DSH 自己的 settings 里；插件只在服务端经 `ctx.llm` 使用，从不直接经手。
- **浏览器通道不传密钥。** `POST /api/llm-ctl/discover` 只收
  `{ provider, baseURL?, api? }`，body 里带 `apiKey` 直接 HTTP 400。
  上游发现只用服务端存好的 credential。
- **日志构造上就不含密钥。** host 日志（`llm-ctl:` 前缀）只记 provider 名、
  失败码、延迟、计数——不记请求体、请求头、credential。

## 给审计者的范围说明

- 浏览器流量全部走本地 `webServer` 的 `/api/llm-ctl/*`；每个 POST body
  限 4 KiB，先校验类型再用。
- 插件只写自己的 settings 分区（user 层的 `llm-ctl`）。
  从不改别人的命名空间（`llm-pi-ai`、adapter 分区）。
- 模型菜单过滤是 DOM 操作（给菜单行加 `display:none`，
  选择器收敛在 `src/menu-filter.ts`）；读不到 picker 之外的页面内容，
  自己也不发网络请求。

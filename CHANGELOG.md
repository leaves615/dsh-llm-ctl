# 更新日志

本项目的所有重要变更都在这里记录。格式遵循
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)；版本号遵循
[SemVer](https://semver.org/)。

## [0.1.1] — 2026-09-23

- 修 `publishConfig.provenance` 导致本地 `npm publish` 必挂（CI 仍经
  `--provenance` 签名）。
- 全仓 md 转中文；CI 支持 `v*` tag 自动发布 npm（OIDC 可信发布）。

## [0.1.0] — 2026-09-23

首个公开发布：DSH web profile 的限流排队 + 模型隐藏。在
`@deepseek-ai/dsh-llm 0.1.2-rc.1` 上测过。

### 新增

- `llm/stream` 上的 per-provider 准入排队（全局 prepend）：严格 FIFO、
  per-provider 并发上限、单个 `maxWaitMs` 预算；`QUEUE_FULL` /
  `QUEUE_TIMEOUT` 拒绝；每条请求可单独取消；排队 pill + 详情弹窗挂在
  `conversation.composer.dock`。
- 终端失败后的 provider  reactive 冷却（失败码 `RATE_LIMIT / SERVER /
  TIMEOUT / TRANSPORT / EMPTY_RESPONSE`）：优先用 `providerRetryAfterMs`，
  没有就本地指数退避；`AUTH / QUOTA` 等码原样透传、不冷却。
- `agent/request-error` 上的 standalone 兜底：先登记冷却，再让
  `dsh-llm-retry` 接管（它处理了就透传）；没人管才花自己的有界预算
  （`reactiveRetry: auto`，默认 3 次）。
- 模型隐藏：provider / 单模型两级开关，持久化到 `llm-ctl` settings 分区；
  `hiddenPatterns` 预置；设置页卡片 + 页脚；模型菜单 DOM 过滤 + 自带搜索框
  （`p:` 前缀按 provider 过滤）；全隐空态一键恢复；默认模型被藏后自动回退。
- 上游模型发现（`POST /api/llm-ctl/discover`）：先走 adapter 发现（服务端用
  存好的 credential），zen 系 provider 失败时回退公开 Zen feed。
  **密钥不过浏览器通道**——body 里带 `apiKey` 直接 HTTP 400。
- 与 `dsh-model-search-plugin` 共存：每次打开菜单时 DOM 探测；对方搜索框
  接管时只隐藏、不重写。

### 已知限制（需要上游开接缝）

- 藏掉的模型照样下发到 host（`session.modelCatalog` 没有 waterfall 接缝）；
  过滤发生在浏览器侧。
- 不写自定义会话日志事件（`Session.append()` 给不了第三方事件类型
  `ignorable` 标记）；可观测性只有 host 日志 + `llmCtl` Remote /
  `/api/llm-ctl/state` 暴露的内存环。

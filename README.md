# @leaves615/dsh-llm-ctl

[![CI](https://github.com/leaves615/dsh-llm-ctl/actions/workflows/ci.yml/badge.svg)](https://github.com/leaves615/dsh-llm-ctl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@leaves615/dsh-llm-ctl.svg)](https://www.npmjs.com/package/@leaves615/dsh-llm-ctl)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English summary](#english-summary) · [中文文档](#工作原理) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## English summary

Admission control + model visibility for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web profiles.

- **Rate-limit queue.** Every `llm/stream` call — agent loop, title generation,
  compaction alike — waits for a per-provider slot before dispatch. Strict
  FIFO, per-provider concurrency caps, one wait budget (`maxWaitMs`). On a
  terminal rate-limit failure the whole provider cools down (honors
  `Retry-After` / `providerRetryAfterMs`, else local exponential backoff);
  queued requests wait instead of dying with 429. Over budget →
  `QUEUE_TIMEOUT`, queue full → `QUEUE_FULL`, each cancellable from the
  composer queue pill.
- **Standalone recovery.** On `agent/request-error` the plugin records the
  cooldown, then yields to `dsh-llm-retry` when it handles the error — and
  otherwise spends its own bounded budget (`reactiveRetry: auto`, cap 3) so
  the first 429 no longer kills the turn on profiles without a retry plugin.
- **Model visibility.** Two-level switches (whole provider / single model)
  persisted to the `llm-ctl` settings section, `hiddenPatterns` presets,
  settings-page cards + footer, model-menu filtering with a built-in search
  box (`p:` prefix filters by provider), empty state with one-click restore,
  and default-model fallback when the current default gets hidden.
- **Upstream discovery.** Refresh button per provider card re-discovers the
  upstream model list (adapter discovery with the stored server-side
  credential, public Zen feed fallback for zen-family routes). Secrets never
  cross the browser channel — `apiKey` in a discover request is rejected
  (HTTP 400).

Relation to sibling plugins: `dsh-llm-retry` is the executor (re-runs failed
requests at durable step boundaries); this plugin is the gatekeeper (queues
before dispatch, cools down after rate limits). `dsh-model-search-plugin`
only searches; this plugin only hides — and yields its search box when the
former is present.

```sh
dsh plugin --profile web add -w @leaves615/dsh-llm-ctl
dsh web   # restart to load
```

Prerequisites: DSH web profile, Node.js >= 22. Tested against
`@deepseek-ai/dsh-llm 0.1.2-rc.1`. Headless loads fine (queue + recovery
active, menu/dock UI dormant without `webServer`).

## 工作原理

拿 zen-free 举例。你把它的并发设成 1，同时开了 5 个任务：第 1 个先跑，剩下 4 个排队。第 1 个撞上 429，还带了 `Retry-After: 12s`——整个 zen-free 冷却 12 秒，排队的 4 个一起等，输入框上方出现「排队 4 · ~12s」，点开每条都能单独取消。12 秒后按排队顺序一个个放行。如果要等的时间超过预算，不等，直接失败告诉你。

插件卡在三个接缝上：

| 接缝 | 职责 |
|---|---|
| `llm/stream`（全局 prepend） | 所有调用——agent 主循环、标题生成、压缩后台任务——按 provider 取到槽位才放行。排队时还没碰 provider，请求只读不改 |
| `agent/request-error`（全局 prepend） | 先登记冷却，再问下游。有 retry 插件接管就透传，没人管就自己花有界预算重试 |
| 设置页 + 模型菜单 + 输入框状态条 | provider 卡开关、菜单过滤、排队 pill，浏览器半走 `/api/llm-ctl/*` 跟 host 说话 |

## 安装

```sh
dsh plugin --profile web add -w @leaves615/dsh-llm-ctl   # 或：add -w /path/to/dsh-llm-ctl
dsh web                                                   # 重启加载
```

`dsh.bundle.patch` 和 `dsh.client` 都已声明，host 和浏览器两半自动装好，不用手改 `cordis.patch.yml`。

### 前置条件

- DSH（含 web profile），Node.js >= 22。
- 在 `@deepseek-ai/dsh-llm 0.1.2-rc.1` 上测过；peer 依赖 `@deepseek-ai/cordis ^4.0.2`。
- headless 也能加载：排队 + 自愈正常工作，只是没有状态条和菜单过滤（缺 `webServer` 时浏览器半休眠）。

## 安装之后

什么都不配就能用：默认不限流，自愈开着，隐藏规则为空。先去两个地方看一眼：

1. 模型设置页——每个 provider 多出一张卡，开关控制显示和隐藏，底部有隐藏总数和全部恢复。
2. 设置 → 插件 → 插件配置——`llm-ctl` 卡，排队预算都在这里改，保存即生效，不用重启。

## 配置

完整配置长这样，每项都有默认值，不写就是下面这个效果：

```yaml
- id: llm-ctl
  name: '@leaves615/dsh-llm-ctl'
  config:
    queue:
      # 每个 provider 几个并发。不写 default 就是全不限流，0 也是不限流。
      perProviderConcurrency: { 'zen-free': 1 }
      maxQueueDepth: 50          # 队满报 QUEUE_FULL
      # 唯一的等待预算：排队愿意等多久，也愿意接受多长的冷却。
      # 明确要等更久就直接报 QUEUE_TIMEOUT，不白等。
      maxWaitMs: 120000
      honorRetryAfter: true      # provider 的提示优先于本地退避
      backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }
    # 没装 dsh-llm-retry 时的兜底：auto = 下游没人管才自己上（默认 3 次）；
    # off = 从不；数字 = 每步最多几次。
    reactiveRetry: auto
    visibility:
      # 启动预置的隐藏规则，用户层只读。通配符只有 '*'，大小写不敏感，
      # 'provider:model' 或裸模型名都行。
      hiddenPatterns: ['*-test-*']
```

排队是严格 FIFO，先到先得，不分前后台优先级。

触发冷却的失败码跟 dsh-llm-retry 默认集一致：`RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE`。直接抛错的算数，包在 SSE 流里回来的 terminal finish chunk（OpenRouter 转发上游 429 就是这样）也算数。`AUTH`、`QUOTA` 这类码不排队，原样透传。

等多久听 provider 的：优先用 adapter 透出来的 `failure.providerRetryAfterMs`（DeepSeek 的 adapter 已经给了），没有就本地指数退避。

> 上游进展：`Retry-After`、`x-ratelimit-reset` 这些 header 的解析器已经写好测过，就等 adapter 把原始响应头放进 `LlmError.details`，接上就能用，插件这边已经收 `headers` 包了。

## 模型隐藏

两级开关：整个 provider 藏（`providers.<id>`），单个模型藏（`models.<provider:model>`），再加启动预置的 `hiddenPatterns`。判定顺序：provider 全藏 > 单模型指定 > provider 显式放行 > 预置规则 > 可见。

开关存在 settings 的 `llm-ctl` section，user 层持久化，换机器还在。设置页把所有声明过的 provider 都列出来，catalog 空的、过期的也有开关；每张卡上有刷新按钮，能重新发现上游模型（服务端用存好的 credential，不碰 secret），新模型挂 "new" 徽标。藏掉默认模型时，默认会自动挪到第一个可见的。

菜单这边：装了 `dsh-model-search-plugin` 就不抢搜索框，只剔除隐藏项；没装则自己补一个，支持 `p:` 前缀（`p:zen flash` 按 provider 过滤），按键不冒泡出去。全被滤掉时有一键恢复入口。

## 不做的事情

- 不做计费和配额统计，不做 token 级限流。
- 不改请求内容，不碰 adapter 的协议逻辑。
- 不做跨进程分布式队列，单进程内存队列够用了。
- **不写别人的配置。** 本插件只写自己的 `llm-ctl` section，`llm-pi-ai` 等别的插件的命名空间一律只读。想给自定义模型补思维等级选择器，去改它自己的配置，别指望本插件代笔（原因见 `notes/reasoning-effort-gap.md` 的下架决策）。

## 已知问题

服务端 `session.modelCatalog` 目前拦不住（没有 waterfall 接缝），"隐藏模型不出 host"需要上游加接缝，过滤发生在浏览器侧。

也不写自定义会话日志事件：`Session.append()` 给不了站外事件 `ignorable` 标记，硬写会让持久化读路径拒绝重建会话。可观测性只有 host 日志和 `llmCtl` Remote 暴露的内存环，等上游开放标记再说。

## 常见问题

**`QUEUE_FULL` / `QUEUE_TIMEOUT` 是什么意思？**
`QUEUE_FULL` = 排队数超过 `maxQueueDepth`（默认 50），新请求直接拒绝，稍后再试或调大队列。`QUEUE_TIMEOUT` = 要等的时间超过 `maxWaitMs`（默认 120s）——已知等不起就立刻失败，不白等；调大 `maxWaitMs` 或降低并发需求可缓解。

**排队能取消吗？**
能。输入框上方的排队 pill 点开，每条请求可单独取消；取消记 `cancelled` 事件，立即释放槽位。

**`SETTINGS_CONFLICT` 保存失败？**
多人/多窗口同时改 `llm-ctl` 配置会撞 revision。刷新设置页重读最新 revision 再保存即可；插件内部写配置自带冲突重试。

**卸载 / 回滚？**
`dsh plugin --profile web remove @leaves615/dsh-llm-ctl` 后重启。`llm-ctl` settings section 残留的开关数据不影响其他插件，清理可手动删除该 section。

**跟 `dsh-llm-retry` 一起装会打架吗？**
不会。`agent/request-error` 上 retry 插件接管时本插件只透传（零重复计数）；只有下游无动作（void）时才花自己的有界预算。装/卸 retry 插件无需改本插件配置。

## 本地开发

```sh
npm install
npm run verify     # typecheck + build + tests + 真实 loader smoke boot
```

`npm run typecheck` 最快，先跑它。`scripts/smoke-boot.sh` 在 `.dsh-home/` 下组装临时 profile（不碰 `~/.dsh`），断言 `llm-ctl` 行装上再随机端口起服。

测试直接跑 TS 源码（Node 类型剥离），所以 host 半没用装饰器语法，Typert `Remote` 标记是在 `src/controller.ts` 里编程式挂的。

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 入口：两个 waterfall listener、预算、remote controller |
| `src/queue.ts` | per-provider 并发、FIFO、冷却时钟、ETA |
| `src/delay.ts` | 延迟阶梯和 header 解析 |
| `src/reactive.ts` | 兜底重试的决策、预算、可中断等待 |
| `src/config.ts` | schema、默认值、并发解析 |
| `src/controller.ts` + `src/routes.ts` | `ctx.remote.llmCtl` 和 `/api/llm-ctl/*` |
| `src/settings-ui.ts` | 设置页 provider 卡、footer、插件配置卡 |
| `src/menu-filter.ts` | 模型菜单 DOM 过滤（选择器只留在这里） |
| `src/menu-visibility.ts` | 外部搜索插件共存：探测到对方搜索框时只隐藏不重写 |
| `src/queue-dock.ts` | 输入框上方的排队状态条 |
| `src/visibility.ts` + `src/visibility-settings.ts` | 开关解析/过滤/回退 + settings section 适配层 |
| `src/discover.ts` + `src/discover-ui.ts` | 上游模型发现（adapter 优先，zen feed 兜底）+ 发现列表视图 |
| `src/concurrency.ts` + `src/events.ts` | 并发解析 + 有界内存控制面日志 |
| `src/client-plugin.ts` | 浏览器半：状态条、菜单同步、HTTP 轮询 |

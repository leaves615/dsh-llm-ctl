# dsh-llm-ctl

给 DSH 加个门卫：模型调用先排队再放行，模型菜单把不用的彻底藏掉。

跟另外两个插件的关系，先说清楚，免得装错：**dsh-llm-retry 是执行器**，在 durable 步骤边界上重跑失败的请求；**我是门卫**，请求发出去之前排队，触发限流后让整个 provider 歇一会儿。有它没它都能装——有它时失败恢复它说了算，我只排队和记冷却。**dsh-model-search-plugin 只做搜索不藏东西**；我只做隐藏，顺手补个搜索框，装了它我的搜索框自动让路。

## 工作原理

拿 zen-free 举例。你把它的并发设成 1，同时开了 5 个任务：第 1 个先跑，剩下 4 个排队。第 1 个撞上 429，还带了 `Retry-After: 12s`——整个 zen-free 冷却 12 秒，排队的 4 个一起等，输入框上方出现「排队 4 · ~12s」，点开每条都能单独取消。12 秒后按排队顺序一个个放行。如果要等的时间超过预算，不等，直接失败告诉你。

插件卡在三个接缝上：

| 接缝 | 干嘛 |
|---|---|
| `llm/stream`（全局 prepend） | 所有调用——agent 主循环、标题生成、压缩后台任务——按 provider 取到槽位才放行。排队时还没碰 provider，请求只读不改 |
| `agent/request-error`（全局 prepend） | 先登记冷却，再问下游。有 retry 插件接管就透传，没人管就自己花有界预算重试 |
| 设置页 + 模型菜单 + 输入框状态条 | provider 卡开关、菜单过滤、排队 pill，浏览器半走 `/api/llm-ctl/*` 跟 host 说话 |

## 安装

```sh
dsh plugin --profile web add -w dsh-llm-ctl   # 或：add -w /path/to/dsh-llm-ctl
dsh web                                        # 重启加载
```

`dsh.bundle.patch` 和 `dsh.client` 都已声明，host 和浏览器两半自动装好，不用手改 `cordis.patch.yml`。

## 安装之后

什么都不配就能用：默认不限流，自愈开着，隐藏规则为空。先去两个地方看一眼：

1. 模型设置页——每个 provider 多出一张卡，开关控制显示和隐藏，底部有隐藏总数和全部恢复。
2. 设置 → 插件 → 插件配置——`llm-ctl` 卡，排队预算都在这里改，保存即生效，不用重启。

## 配置

完整配置长这样，每项都有默认值，不写就是下面这个效果：

```yaml
- id: llm-ctl
  name: 'dsh-llm-ctl'
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

## 已知问题

服务端 `session.modelCatalog` 目前拦不住（没有 waterfall 接缝），"隐藏模型不出 host"需要上游加接缝，过滤发生在浏览器侧。

也不写自定义会话日志事件：`Session.append()` 给不了站外事件 `ignorable` 标记，硬写会让持久化读路径拒绝重建会话。可观测性只有 host 日志和 `llmCtl` Remote 暴露的内存环，等上游开放标记再说。

## Compatibility

web profile。`webServer` 和 `llm` 按可选对待，headless 也能加载（只是没状态条和菜单过滤）。在 `@deepseek-ai/dsh-llm 0.1.2-rc.1` 上测过，peer 要 `@deepseek-ai/cordis ^4.0.2`。

## 本地开发

```sh
npm install
npm run verify     # typecheck + build + tests + 真实 loader smoke boot
```

`npm run typecheck` 最快，先跑它。`scripts/smoke-boot.sh` 在 `.dsh-home/` 下组装临时 profile（不碰 `~/.dsh`），断言 `llm-ctl` 行装上再随机端口起服。

测试直接跑 TS 源码（Node 类型剥离），所以 host 半没用装饰器语法，Typert `Remote` 标记是在 `src/controller.ts` 里编程式挂的。

| 文件 | 干嘛的 |
|---|---|
| `src/index.ts` | 入口：两个 waterfall listener、预算、remote controller |
| `src/queue.ts` | per-provider 并发、FIFO、冷却时钟、ETA |
| `src/delay.ts` | 延迟阶梯和 header 解析 |
| `src/reactive.ts` | 兜底重试的决策、预算、可中断等待 |
| `src/config.ts` | schema、默认值、并发解析 |
| `src/controller.ts` + `src/routes.ts` | `ctx.remote.llmCtl` 和 `/api/llm-ctl/*` |
| `src/settings-ui.ts` | 设置页 provider 卡、footer、插件配置卡 |
| `src/menu-filter.ts` | 模型菜单 DOM 过滤（选择器只留在这里） |
| `src/queue-dock.ts` | 输入框上方的排队状态条 |
| `src/client-plugin.ts` | 浏览器半：状态条、菜单同步、HTTP 轮询 |

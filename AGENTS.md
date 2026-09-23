# @leaves615/dsh-llm-ctl — agent 指南

DSH 插件：`llm/stream` 上的 per-provider 准入排队 + 冷却、`agent/request-error` 上的有界自愈、`settings.models` 座位上的模型隐藏开关、模型菜单的 DOM 过滤。

## 命令

- `npm run typecheck` —— 最快的反馈，先跑它。
- `npm run build` —— host 侧 `tsc` + `esbuild` 打浏览器包（`scripts/build-client.mjs`）。
- `npm test` —— `node --test test/*.test.ts`（DOM 模块用 jsdom）。
- `npm run verify` —— typecheck + build + test + `./scripts/smoke-boot.sh`。全绿才能发。

## 文件地图

- `src/index.ts` —— host 入口：`llm/stream` 门卫、`agent/request-error` 自愈、路由挂载。排队/重试问题从这里开始。
- `src/queue.ts` + `src/delay.ts` + `src/reactive.ts` —— 门卫、Retry-After/退避、可等待失败码集合。
- `src/visibility*.ts` + `src/settings-ui.ts` —— settings 分区 `llm-ctl` 适配层、隐藏规则、provider 卡片/页脚视图，以及设置 → 插件 → 插件配置里的 `settings.plugin.item` 卡片（`PluginConfigCard`，管全局排队预算）。
- `src/menu-filter.ts` + `src/menu-visibility.ts` —— 模型菜单 DOM 过滤（唯一的 DOM 操作区；选择器只留在这里）。
- `src/queue-dock.ts` —— `conversation.composer.dock` 座位视图（纯函数；跟 `settings-ui.ts` 用同一套 token）。
- `src/client-plugin.ts` —— 浏览器半：dock 排队座位、菜单同步、slot 座位、HTTP 轮询。
- `src/routes.ts` + `src/discover*.ts` —— `webServer` 普通 HTTP 通道、上游模型发现。
- `cordis.patch.yml` —— host 侧 insert 行（`id: llm-ctl`）；浏览器半经 `package.json#dsh.client` + `exports["./client"]` 跟着走。
- `PRD.md` —— 行为契约；`README.md` —— 接缝表 + 配置示例；`notes/dsh-extension-points.md` —— 接缝目录（含出处）。

分支对得上就读对应的指针目标：

- 改排队/重试语义 → `PRD.md`（FIFO、单个 `maxWaitMs`、`reactiveRetry` 模式）。
- 改设置页/菜单/发现 UI → `README.md` 行为说明 + `notes/dsh-extension-points.md` §3/§5。
- 新增 host waterfall 或 slot 座位 → `notes/dsh-extension-points.md` §2–§4（官方接缝还是 DOM 操作）。

## 规则

- waterfall 顺序：`llm/stream` 先排队；`agent/request-error` 先登记冷却、等 `next()`，只有下游没动作时才花自己的预算。
- `llm/stream` 的请求只读不改；拒绝放行时回一个 `finish/error` chunk，不许改 options。
- settings 经 `mutate` + `expectedRevision` 写 `llm-ctl` 分区；`SETTINGS_CONFLICT` 时重试。
- **只写 `llm-ctl` 分区。** 不许碰别人的命名空间（`llm-pi-ai`、adapter 分区……）——别人的 `describe()` 快照不许回写，跨命名空间的 `expectedRevision` 不许用。读别人的分区可以；写永久出局（2026-09-22 决策，见 `notes/reasoning-effort-gap.md`）。
- `webServer` 和 `llm` 按可选对待：`inject` 带 fallback，`ctx.get` 包 try/catch，headless 保持可加载。
- `settings.models.provider-card` 每个 `settingsNs` 只注册一次；行归属渲染时从 owner props 取，不许用注册闭包。
- 浏览器包保持纯净：相对导入打包内联，`react`/`cordis`/slots 包走外部；`scripts/build-client.mjs` 里断言 `apply` 形状。
- 菜单选择器、`MutationObserver` 去重、`stopPropagation` 收敛在 `menu-filter.ts` / `client-plugin.ts` 菜单同步里；`dsh-model-search-plugin` 拥有搜索框时只隐藏。
- HTTP 路径统一 `/api/llm-ctl/` 前缀；状态 1s 轮询，目录 30s TTL。

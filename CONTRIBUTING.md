# 参与贡献 @leaves615/dsh-llm-ctl

欢迎。这里是 DSH（DeepSeek Harness）插件，有几处跟普通 npm 库不一样——先读完，能省一轮返工。

## 前置条件

- Node.js >= 22（CI 跑 22.x 和 24.x）。
- `smoke-boot` 需要能用的 DSH 环境：`scripts/smoke-boot.sh` 默认用
  `~/.dsh/profiles/web` 做源 profile。没有这个环境时，
  `npm run verify` 跑到 `npm test` 为止是正常的——PR 里说明一下即可。
- 先跑 `npm install`。

## 命令

| 命令 | 作用 | 什么时候跑 |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit`，最快的反馈 | 永远先跑它 |
| `npm run build` | host 侧 `tsc` + `scripts/build-client.mjs` 打浏览器包 | 动过 `src/` 就跑 |
| `npm test` | `node --test test/*.test.ts`（直接跑 TS，不用先构建） | 动过 `src/` 或 `test/` 就跑 |
| `npm run verify` | typecheck + build + test + 真实 loader `smoke-boot.sh` | 开 PR 之前，必须全绿 |

## 文件地图

`AGENTS.md`（仓库根目录）是模块地图和硬规则的唯一正解。简版：

- `src/index.ts` —— host 入口：`llm/stream` 门卫 + `agent/request-error` 自愈。
- `src/queue.ts` / `delay.ts` / `reactive.ts` —— 门卫、Retry-After/退避、可等待失败码。
- `src/visibility*.ts` / `settings-ui.ts` —— settings 分区 `llm-ctl`、隐藏规则、设置页视图。
- `src/menu-filter.ts` / `menu-visibility.ts` —— **唯一的 DOM 操作区**；菜单选择器只许出现在这里。
- `src/client-plugin.ts` —— 浏览器半（轮询 `/api/llm-ctl/*`，没有 `ctx.remote`——第三方 Typert 命名空间在浏览器侧不可达）。
- `src/routes.ts` / `discover*.ts` —— 挂在可选 `webServer` 服务上的普通 HTTP 通道、上游模型发现。
- `PRD.md` —— 行为契约（FIFO、单个 `maxWaitMs`、`reactiveRetry` 模式）。改行为必须同 PR 更新 PRD。
- `notes/dsh-extension-points.md` —— 接缝目录（含出处）。新增 host waterfall 或 slot 座位先查这里（官方接缝还是 DOM 操作）。

## 硬规则（review 时执行）

1. **只写 `llm-ctl` 这一个 settings 分区。** 读别人的分区可以；写 `llm-pi-ai`、adapter 分区或任何 `llm-ctl` 之外的分区都出局——永久（2026-09-22 决策，见 `notes/reasoning-effort-gap.md`）。
2. **`llm/stream` 的请求只读不改。** 拒绝放行时回一个 `finish/error` chunk；不许改 options。
3. **waterfall 顺序不能反：** `llm/stream` 先排队；`agent/request-error` 先登记冷却、再等 `next()`，只有下游没动作时才花自己的预算。
4. **HTTP 路径统一 `/api/llm-ctl/` 前缀。** 状态 1s 轮询，目录 30s TTL。
5. **密钥不过浏览器通道。** `/api/llm-ctl/discover` 拒绝 body 里的 `apiKey`；发现上游模型只用服务端存好的 credential。
6. **浏览器包保持纯净：** 相对导入打包内联，`react`/`cordis`/slots 包走外部；`scripts/build-client.mjs` 会断言 `apply` 形状。
7. **测试直接跑 TS 源码**（Node 类型剥离），所以 host 半不用装饰器语法——Typert `Remote` 接线在 `src/controller.ts` 里手写。

## 开 PR

- `npm run verify` 全绿（缺哪条、为什么缺，写清楚）。
- 行为变更 → 同 PR 更新 PRD。
- 新增菜单选择器 → 必须落在 `menu-filter.ts`，并在 `menu-visibility.test.ts` / `client-plugin.test.ts` 里加用例钉住。
- 一次 PR 只做一件事。

## 报 bug

开 issue 请带：DSH 版本（`@deepseek-ai/dsh-llm` 版本）、插件版本、
profile（`web`？headless？）、host 日志里 `llm-ctl:` 开头的行。
卡住不动的，附 `/api/llm-ctl/state` 快照。**不要贴 API key、
token 或完整 `settings.yaml`**——先脱敏（见 `SECURITY.md`）。

# 自定义 provider 模型缺思维等级选择：根因与补齐方案（研究）

> ⚠️ **该功能已于 2026-09-22 彻底下架，本文只剩根因研究价值，§5 起的实现方案全部作废。**
> 决策：本插件只写自己的 `llm-ctl` section，禁止写 `llm-pi-ai` 等别的插件的命名空间。
> 而 §2/§3 证实能力声明只能落在 pi-ai 自己的 ns（派发期 `UNSUPPORTED_REASONING_EFFORT` 硬校验，绕不过），
> 所以"补齐选择器"与"不写别人配置"不可兼得，按后者取舍：功能下架，根因留档。
> 曾实现过一版（host 写路径 + `POST /api/llm-ctl/reasoning-efforts` + 插件配置卡内控制台），
> 因两点被撤：① 把 `describe().value`（resolved 视图）整段回写 user 层，物化了继承、大 diff 改动原配置；
> ② UI 未按 `settings.plugin.item` 规范落位（控制台渲染在 `<li>` 卡外、hook 条件调用、无暂存-保存）。
> 若将来上游开放第三方能力声明接缝，重开时按 §5/§6 重做，但写入面必须只碰目标叶子路径。

> 方法：只认一手来源。D = `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（DSH 实现 checkout，只读），
> W = 本仓库（`@leaves615/dsh-llm-ctl`），ZP = `dsh-opencode-zen-free-provider` 源码。
> 结论：选择器不是 UI 漏画，而是**按模型能力声明**渲染的；自定义模型缺的是 `reasoningEfforts` 声明。
> ~~插件侧唯一官方正路是**帮用户把声明写进 `llm-pi-ai` 配置**~~（该路径已被上述决策否决）。

## 1. 现象（用户报告）

- 官方 provider 的模型：composer 模型座位有思维等级（effort）选择。
- `zen-free-provider` 的模型：也有选择（它自带 adapter 能力声明，见 §3）。
- 用户自建的自定义 provider 下的模型：**没有**思维等级选择。

## 2. 官方链路（选择器何时出现）

调用链（每一步都有源码证据）：

```
adapter 模型描述 (reasoning/thinkingLevelMap)
  → ctx.llm.resolveModelInfo(provider, model) : LlmResolvedModelInfo.reasoning?
  → session-controller buildModelCatalog() : ModelCatalogModel.reasoning?
  → client ModelDirectory / ModelSelect：reasoning === undefined → 不渲染 effort UI
  → session.selectModel({provider, model, reasoningEffort?}) → llm.resolveCallConfig 校验
```

关键证据：

- `LlmResolvedModelInfo.reasoning?: LlmModelReasoningInfo`（`D/dsh-llm/lib/types/types.d.ts:321-328`）；
  `reasoning` 缺席 = “capability 不可用”，调用方只能用 provider 默认（`D/dsh-llm-pi-ai/lib/index.js:1696-1721` 注释原文：
  *“Omitting `reasoning` entirely is the seam's way of saying the capability is unavailable”*）。
- 目录构建：`resolved.reasoning === undefined ? 省略 : 透传 efforts/defaultEffort`
  （`D/dsh-api-session-controller/lib/index.js:1993-2008`）。
- Picker 门控：`const reasoning = currentChoice?.model.reasoning; … reasoning === undefined ? [] : …`
  且 trigger 只在 `reasoning !== undefined` 时拼 effort（`D/dsh-client-ui-model-selection/lib/client.js:424-442,566-571`）。
  所以**目录里没有 `reasoning` 的模型天然没有选择器**——不是 bug，是门控。
- 选择校验：`resolveCallWithInfo` 中 `reasoning === undefined && requested !== undefined → throw UNSUPPORTED_REASONING_EFFORT`
  （`D/dsh-llm/lib/index.js:2116-2128`）。硬造 UI 而不声明能力，`selectModel` 会直接被拒。
- 官方 deepseek adapter 永远带 `reasoning`（`REASONING_EFFORTS` / `OFF_ONLY`，`D/dsh-llm-deepseek/lib/index.js:1417-1444,1578-1600`），
  所以官方模型总是有选择——与用户观察一致。

## 3. 为什么 zen 有、自定义没有

- pi-ai 侧能力物化规则（`D/dsh-llm-pi-ai/lib/index.js:562-584` `resolveModelReasoning`）：
  - `reasoningEfforts === undefined` → 继承安装目录（`base?.reasoning ?? false`）；
  - `false` → 非推理模型（无选择器）；
  - 非空 dict → `reasoning: true + thinkingLevelMap`（未声明的 level 钉为 `null`=不支持；只有 `off` 可空）。
  - 校验：空 dict 拒绝；必须含至少一个 `off` 之外的 level；非 `off` 的每个 level 必须有非空 wire 值
   （同文件 `566-574`；schema 见 `967/974`，`reasoningEfforts: false | dict(level → string|null)`）。
- 手工声明的路由（`llm-pi-ai` settings 里手写的 `providers.<route>.models[]`）**没有安装目录条目**，
  `omit reasoningEfforts` 即落到 `false` → `reasoningInfo()` 返回 `{}`（同文件 `1712-1721`）→ 目录无 `reasoning` → 无选择器。
  **这就是自定义 provider 缺选择的根因。**
- zen 之所以有：它根本不走 `llm-pi-ai` 的 settings 模型表。它自己 `new PiAiAdapter` 并用
  `createProvider` 直构 `piProvider`，`scanned` 模型带 `reasoning: controllable + thinkingLevelMap`
  （`ZP/src/index.ts:344-376 reasoningLevelsFor/reasoningMapFor, 379-431 buildModels`），
  路由 `PROVIDER = name = 'opencode-zen-free-provider'`，`settingsNs = 'opencode-zen-free-provider'`，`settingsPath = []`
  （`ZP/src/index.ts:27-29,502`）。能力来自它自己的 feed 扫描（`reasoning_options[type=effort].values`），与设置页无关。
- 可选等级词表（escalation order）：`off, minimal, low, medium, high, xhigh, max`
  （`D/dsh-llm-pi-ai/lib/index.js:296-304 THINKING_LEVELS`；`getSupportedThinkingLevels` 见 `@earendil-works/pi-ai/dist/models.js`：
  `reasoning=false → 仅 off`；`map[level]===null → 不支持`；`xhigh/max` 须显式在 map 中）。
- 发包语义（`@earendil-works/pi-ai/dist/api/openai-completions.js:727-733` 默认分支）：
  `reasoning_effort = thinkingLevelMap[level] ?? level`，且须 `model.reasoning && compat.supportsReasoningEffort`。
  即 dict 的 **value 是 wire 拼写**，key 是选择器 id。MVP 用恒等映射（value=key）即标准 OpenAI 拼写。
- `off` 的语义：`streamSimple` 把 `off` 钳为 `undefined`（不选），`buildParams` 无选择时发 `map.off`（若为 string）否则发空
  （`dist/api/openai-completions.js:539-545,731-733`；zen 注释 `ZP/src/index.ts:353-362`：completions 侧 `off:'off'` 是真开关，
  responses 侧 `off:null`=“上游决定”，且此时选择器不列 Off）。

## 4. 官方插件范围内的可行/不可行路径

范围依据：`W/notes/dsh-extension-points.md §2–§4` 与 `W/AGENTS.md Rules`。

| 路径 | 官方接缝 | 结论 |
|---|---|---|
| A. 在设置页给 `llm-pi-ai` 行补“每模型 effort 声明”编辑器 | C3 `settings.models.provider-card`（keyed，key=settingsNs）+ H5 settings 读写 + H6 webServer HTTP + H8 `ctx.llm.resolveModelInfo` 只读 | ✅ **唯一正路**（本方案）。官方 `CustomProviderCard.d.ts` 明说 effort 是 per-MODEL 能力，provider 级控件会被部分模型拒绝——所以我们的编辑器也必须是 per-model 的，与官方 rationale 一致 |
| B. `agent/request` waterfall 代填 effort | H3 `agent/request`（返回 `LlmCallConfig`，`D/dsh-agent/lib/types/runtime-types.d.ts:336-341`） | ❌ 作为主方案拒绝：effort id 是 adapter 私有词表，插件自 covariates 会绕过校验；且目录不变→选择器依然不出现，解决不了“补齐选择”的诉求 |
| C. 占 `conversation.input.model` 加自己的选择器 | C4：该槽 `kind:'single'`（`D/dsh-client-ui-conversation/.../slots.d.ts:231`），注册=替换官方 `ModelSelect` | ❌ 会毁掉模型选择器，超出“补缺口”的授权 |
| D. DOM hack 往 composer/菜单塞选择器 | X1（唯一 DOM 区是 `W/src/menu-filter.ts` 菜单过滤） | ❌ 无能力声明时 `selectModel→resolveCallConfig` 必抛 `UNSUPPORTED_REASONING_EFFORT`，假 UI 写不进去 |
| E. 另起 adapter/复刻 provider | provider 归属是别人的插件 | ❌ 职责越界，分裂路由 |
| F. client 直写 `remote.settings` | 官方 Models 页确实用 `ctx.remote.settings.mutate(ns, ops, rev)`（`D/dsh-client-ui-settings-models/lib/client.js:2599-2610`） | ⚠️ 技术上可行，但本插件既有架构是“client 只走自家 HTTP + host 持有 settings”（`W/src/routes.ts:1-11` 注记第三方 remote 不可达先例），为保持单通道与纠错面，写操作收敛到 host 路由（A 的一部分），不另开 client 直写 |

## 5. 方案 A 设计（MVP）

### 5.1 写哪一层

- 目标命名空间永远是该行归属的 `settingsNs`（`ProviderDirectoryEntry.settingsNs`，`…/slot-contract.d.ts`；
  本插件 seat 已从 owner props 解析行归属 `W/src/client-plugin.ts:589-603 resolveSeatProvider`——共享 `llm-pi-ai` ns 的多行不会写错键）。
- 只对 `settingsNs === 'llm-pi-ai'` 的行生效；zen 等自有 ns 的行（能力自带）不打扰。
- 手工路由（`settingsPath = ["providers", route]`，`D/dsh-llm-pi-ai/lib/index.js:2562`）：
  读出 `providers.<route>.models` 数组，改其中一个 entry 的 `reasoningEfforts` 后**整数组回写**
  （`set ['providers', route, 'models'] = nextArray`）。
  注意 settings 的 `applyPathOp` 对数组子节点不做对象合并（`D/dsh-settings/lib/index.js:118-151`：数组 proto 不是 plain object），
  所以按下标 path 写是错的，必须数组级读-改-写。
- 目录路由（`models` 为空、命中安装目录）：用 `modelOverrides.<id>.reasoningEfforts` 逐模型覆盖
  （`models` 与 `modelOverrides` 并存会被 `invalid` 拒绝，见 `resolveRouteModels` 同文件 `660-700`），
  path 为 `['providers', route, 'modelOverrides', modelId, 'reasoningEfforts']`，天然是对象路径。
- 写通道：host 新增 `POST /api/llm-ctl/reasoning-efforts`（AGENTS 规则：前缀 `/api/llm-ctl/`），
  host 用 `ctx.inject(['settings'])` 拿到的 `settings.describe()/mutate(ns, ops, expectedRevision)` 落盘
  （H5；`mutate` 允许任意已注册 ns，`D/dsh-settings/lib/types/index.d.ts:236-280`；冲突码 `SETTINGS_CONFLICT` 原样回给 UI 重试，
  与 `W/src/visibility-settings.ts:302-317` 一致）。
- 严格校验错误（`assertServiceable` 系，如 “needs an api”“offers no level beyond off”）原样透出，不吞。
- 生效：pi-ai `installSection.onChange` 重建 profiles（`D/dsh-llm-pi-ai/lib/index.js:2669-2683`；zen 同理 `ZP/src/index.ts` onChange 重建），
  `applies` 默认 live；client 侧目录 30s TTL/重载后选择器出现（本插件 catalog 轮询见 AGENTS：state 1s / catalog 30s TTL）。

### 5.2 声明什么值（MVP 默认）

- UI 预设：`minimal, low, medium, high` ＋ `off`（恒等映射：`{off: null, minimal:'minimal', low:'low', medium:'medium', high:'high'}`）。
  - `off:null` = “上游决定”（发包为空），此时选择器不列 Off（zen 同款语义）；若用户要显式 Off 开关再另给 `off:'off'` 选项。
  - `xhigh/max` 默认不勾，收进“高级”折叠（需要显式 map 条目才被 offered，不勾=不支持，最诚实）。
- 同时写 `compat.supportsReasoningEffort: true`（模型级；路由级会跳过不兼容协议的模型，见 `resolveModelCompat`）。
  理由：私网关 baseURL 下 pi-ai 的探测按 OpenAI 猜（`catalog.d.ts PiAiCompatProfile` 文档），不可靠；显式声明最稳。
  若探测本来就为 true，多写一次无害（同值覆盖）。
- 提供“重置”（`unset` 该字段）回到继承/无能力状态。`false`（显式剥夺）仅用于目录模型纠错场景，默认不提供以免误伤。
- 路由级默认 effort（`reasoning: <level>`，`config.d.ts`）MVP 不做——picker 在 `defaultEffort === undefined` 时本就提供
  “provider default” 项（`client.js:434-437`），够用且避免“默认等级被个别模型拒绝”整 provider 消失的坑
  （`describableReasoningLevel` 只是描述侧容错，请求侧仍会拒，见 `1691-1695`）。

### 5.3 界面放在哪

- 现有 `settings.models.provider-card` seat 内（`W/src/client-plugin.ts:680-698 ensureProviderSeats` 按 ns 注册一次），
  在 `ProviderVisibilityCard` 下新增 “思维等级” 分区（`W/src/settings-ui.ts` 纯视图 + 单测，沿用折叠基元 `COLLAPSE_THRESHOLD=8` 风格）。
- 显示条件（host 下发 `effort.supported: boolean`，经 `ctx.llm.resolveModelInfo` best-effort 判定，失败=unknown=不展示）：
  仅 `llm-pi-ai` 行、且该模型当前无 `reasoning` 的行展示“启用”；已有能力的行展示只读 levels（来自目录 `reasoning.efforts`）+ 重置。
- 文案必须诚实：“level 是发往 `reasoning_effort` 的深度档；端点不认会请求失败，届时请重置”。未知端点建议从 `low/medium/high` 起步。
- 不碰 `conversation.input.model`、不碰菜单 DOM（§4 C/D 已否决）。

### 5.4 host 状态扩展

- `ControlState.visibility` 新增 `effort: Array<{provider, model, supported, levels?: string[], defaultEffort?: string}>`
  （或并入每 provider 的 models 元信息；字段名待定，PRD 更新时锁定）。
- 数据源：`listProviders/listModels`（已有 `W/src/index.ts:345-365 collectCatalog`）+ 新增 `resolveModelInfo` 只读调用，
  包 `try/catch`（AGENTS：`ctx.get` 包住，headless 可加载）。

## 6. 验收标准（MVP）

1. 自建 `llm-pi-ai` 路由 + 手工模型（此前无选择器）：设置卡出现“思维等级→启用”，选默认 4 档保存成功。
2. `settings.yaml` 中 `llm-pi-ai.providers.<route>.models[].reasoningEfforts` 落盘为恒等 dict（含 `compat.supportsReasoningEffort: true`）。
3. 目录重载后 composer 模型菜单出现 effort 选择（含 provider-default），选中某档可完成一次真实请求（或至少 `selectModel` 成功）。
4. 并发编辑冲突返回 `SETTINGS_CONFLICT` 并可重试；非法 level/空集被拒且错误可读。
5. zen 行、官方行无新增 UI；`npm run verify` 全绿（typecheck + build + test + smoke）。
6. 文档：`README` 行为注记 + `notes/dsh-extension-points.md §3/§5` 补本接缝（AGENTS 指针规则）。

## 7. 待用户拍板的两个默认值

- Q1：默认档位 = `minimal/low/medium/high + off(null)`？还是更保守的 `low/medium/high`？（推荐前者：覆盖延迟敏感→深度任务，且与 pi-ai 五基线一致）
- Q2：`off` 语义 = `null`（上游决定，选择器无 Off）还是 `'off'`（显式关闭开关）？（推荐 `null` 起步；用户要真开关再切）

## 8. 非目标（本轮不做）

- 路由级默认 effort、thinkingBudgets/token budget、thinkingFormat/chat-template 等 wire 微调——字段各自独立，后续按需单开。
- responses 协议私网关的 `off` 特殊处理（zen 已验证 responses 拒绝伪造 off 值；通用方案 MVP 先只保证 completions 私网关，responses 行走 `off:null`）。
- 任何对 `conversation.input.model` single 槽的替换、任何 composer 菜单 DOM 注入。

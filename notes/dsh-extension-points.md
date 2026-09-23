# DSH 界面扩展点调研（@leaves615/dsh-llm-ctl 视角）

方法：只认一手来源——DSH 官方包源码／类型定义、package.json 的 dsh.* 声明、
cordis.patch.yml 语义、本仓库真实用法。每个结论后注明来源文件路径。
路径约定：D=…/.dsh/profiles/web/node_modules/@deepseek-ai/（DSH 实现 checkout，只读），
W=…/workspaces/cj/dsh-llm-ctl/（本仓库），WN=W/node_modules/@deepseek-ai/。
凡标“待验证”的，均是未在源码中找到直接证据、不许当作 API 使用的条目。

GUI 背后的组成：http://127.0.0.1:3080 由 dsh-web-app bundle 装配——host 侧是 cordis 服务树
（dsh-base 核心 + web-only 行），client 侧是浏览器 roster（各 dsh-client-ui-* 的 ./client 半部），
经 dsh-client-modules node 半部扫描 dsh.client 声明后组成 window.__DSH_BOOT__ 下发。

## 1. 概述表

| # | 扩展点 | 侧 | 声明方式 | 一手来源 |
|---|--------|----|----------|----------|
| H1 | llm/stream waterfall（拦截／准入／改写 chunk 流） | host | ctx.on('llm/stream', fn, {global:true, prepend:true}) | D/dsh-llm/lib/types/index.d.ts:43（@mode waterfall），W/src/index.ts:131-160 |
| H2 | agent/request-error waterfall（失败恢复，返回 {kind:'retry'} 或调 next() 委托） | host | 同上 | D/dsh-agent/lib/types/runtime-types.d.ts:279-287，W/src/index.ts:224-231 |
| H3 | 其它 waterfall：agent/request、agent/pre-step、tools/pre-execute／around、system-prompt/assemble | host | ctx.on(name, (payload, next)=>…) | D/dsh-agent/lib/types/runtime-types.d.ts:239-263，D/dsh-tools/lib/types/index.d.ts，D/dsh-system-prompt/lib/types/index.d.ts:27 |
| H4 | 只观察事件（emit／serial／parallel）：agent/status、inbox 系列、agent/session-start、agent/turn-stopping、agent/error、session/event、session/flush | host | ctx.on(name, cb)（无 next，不可否决） | D/dsh-agent/lib/types/runtime-types.d.ts:160-227,305-325，D/dsh-session/lib/types/index.d.ts:42-73 |
| H5 | settings section：register（自有）／installSection（可选依赖，可 fallback） | host | ctx.inject(['settings'],…) 内调 settings.register/installSection；读 scope.get/watch，写 update/replace/mutate | D/dsh-base/…/dsh-settings/lib/types/index.d.ts:216-282，W/src/visibility-settings.ts:1-19,123-128 |
| H6 | HTTP 路由 webServer.register（浏览器通道） | host | ctx.inject(['webServer'],…) 内 server.register(route)，返回 disposer；ctx.effect 释放 | D/dsh-host-webserver/lib/types/index.d.ts:64-106，W/src/index.ts:346-389，W/src/routes.ts:17-27 |
| H7 | 工具 ctx.tools.register(defineTool(…))；命令 ctx.commands.register；MCP 每 server 一实例（mcp__<server>__<tool>） | host | 服务调用（非事件） | D/dsh-tools/lib/types/index.d.ts:106,602，D/dsh-commands/lib/types/index.d.ts:35-50，D/dsh-mcp-client/lib/types/index.d.ts:4,21-31 |
| H8 | llm 读侧：listProviders/listModels、listConfigurableProviders/discoverModels；agentDefaultModel.currentSelection/saveSelection | host | ctx.get('llm')／ctx.get('agentDefaultModel')（try/catch，可缺） | D/dsh-llm/lib/types/index.d.ts:277-299，D/dsh-llm/lib/typert.remote-client.d.ts:10-16，W/src/index.ts:233-245,303-335 |
| C1 | dsh.client 发现：package.json dsh.client{platform,inject} ＋ exports[./client] bundle | client | package.json 声明 ＋ esbuild 打包为 __ModuleLoader__.load({id,factory}) 信封 | W/package.json:19-30，D/dsh-client-modules/lib/types/index.d.ts:1-30，D/dsh-client-modules/lib/types/client/manifest.d.ts:38-59,130-138，W/scripts/build-client.mjs |
| C2 | slot 注册：slots.inject(slot, ()=>slots.register({name[,key],order?}, Comp))，ctx.effect 托管释放 | client | declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap } 类型合并＋运行时 register | D/dsh-client-ui-renderer/lib/types/client/registry.d.ts，W/src/client-plugin.ts:39,650-676,693-715 |
| C3 | settings.models.provider-card（keyed，key=settingsNs）＋ settings.models.footer（list） | client | C2 机制，key 取自目录条目 | D/dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts，D/…/ModelsSection.d.ts:35-42，W/src/client-plugin.ts:561-676 |
| C3b | settings.plugin.item（keyed，key=settings namespace）：第三方插件卡片的官方入口。tab 只按 Host 服务的命名空间分发（renderSlot('settings.plugin.item', {}, { entryKey: ns })），卡片自绘整张 `<li>`（可折叠 header＋暂存字段＋保存/放弃）；写入经 client settings scope 按 revision 设栅，命名空间不可用时不渲染 | client | C2 机制，key=自有 settings ns；卡片自带暂存与保存 | D/dsh-client-ui-settings-plugins/lib/types/client/slot-contract.d.ts、card-form.d.ts、PluginCard.d.ts，W/src/client-plugin.ts（settings.plugin.item 注册）、W/src/settings-ui.ts（PluginConfigCard） |
| C4 | 其它 UI slot：shell.overlay（list，加法浮层）、sidebar／conversation／details（single，占位即替换）、conversation.*、chat 渲染器、settings.*、trajectory／tool／workspace／approval 等 | client | C2 机制；single 槽注册＝替换 | D/dsh-client-ui-layout/lib/types/client/index.d.ts:19-80，D/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts，D/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts，D/dsh-client-ui-chat/lib/types/client/contract/slots.d.ts，D/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts |
| C5 | composer 模型座位 ＋ /model 弹窗 occupant（model-selection 只贡献 occupant，不拥有 SlotMap） | client | 向 conversation.input.model 座位注册 occupant | D/dsh-client-ui-model-selection/lib/types/client/slots.d.ts，D/…/model-selection/lib/types/client/index.d.ts |
| C6 | 浏览器 remote 读侧：ctx.remote.session.modelCatalog()、ctx.remote.llm.listConfigurableProviders() | client | client inject=['slots','remote','remote.session'] 后经 ctx 取得 | W/src/client-plugin.ts:38-39,92-103，D/dsh-llm/lib/typert.remote-client.d.ts:10-16 |
| C7 | React 外置／静态模块表：bundle 内 require('react')，react/cordis/store/slots/primitives 等走 externals；未知 specifier 直接 throw | client | esbuild external＋运行时模块表 | W/scripts/build-client.mjs:20-31，D/dsh-client-modules/lib/types/client/manifest.d.ts:41-59,99，D/dsh-client-modules/lib/types/index.d.ts:47-49 |
| C8 | HMR：host clientModuleHost＋ClientModuleRegistry.rebuilt；browser 经 revisioned combo 端点重取 | client | 服务＋wire（rev/url），dev 侧另有 bundle watch | D/dsh-client-modules/lib/types/index.d.ts，D/dsh-client-hmr/lib/types/index.d.ts，D/dsh-client-modules/lib/types/client/manifest.d.ts:86-99 |
| P1 | profile 组装：dsh.profile.bundles → 各包 dsh.bundle.patch → 本 profile cordis.patch.yml → --patch overlay | 装配 | package.json 声明＋patch 数组（insert／id 覆盖／disable） | web profile package.json、cordis.yml 头注释、cordis.patch.yml、D/dsh-base/cordis.patch.yml 头注释、D/dsh-web-app/cordis.patch.yml 头注释、D/dsh-base/lib/types/index.d.ts |
| X1 | 非官方 DOM hack：model 菜单 div[role=menu]／section[role=group]／[role=menuitemradio] 模糊匹配＋display:none＋MutationObserver＋轮询 | client | 无声明，直接读写 DOM | W/src/menu-filter.ts:1-11,94-140，W/src/menu-visibility.ts:1-12，W/src/client-plugin.ts:105-113,678-690,700-703 |

## 2. Host 侧扩展点

### 2.1 Waterfall 事件（可拦截、可短路、可委托）

cordis 事件三要素：名字＋payload＋next()。类型定义用 @mode waterfall 标注，
ctx.on(name, fn, {global:true, prepend:true}) 表示全局＋插到链头。本仓库两个接缝都是该形状：

```ts
// W/src/index.ts:131-160 —— llm/stream 准入队列（官方注释见 D/dsh-llm/lib/types/index.d.ts:38-52）
const disposeStream = ctx.on('llm/stream',
  (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    return (async function* admission(): AsyncIterable<StreamChunk> {
      const outcome = await gate.acquire(provider, { origin, signal });
      if (!outcome.ok) { yield refusalChunk(outcome.code, '…'); return; } // 短路：不调 next()
      try { for await (const chunk of next()) { observeTerminal(provider, origin, chunk); yield chunk; } }
      finally { outcome.release(); }
    })();
  },
  { global: true, prepend: true },
);
```

```ts
// W/src/index.ts:224-231 —— agent/request-error 独立恢复（契约见 D/dsh-agent/lib/types/runtime-types.d.ts:264-287）
const disposeError = ctx.on('agent/request-error',
  (payload: RequestErrorPayload, next: () => Promise<RequestErrorAction>) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    return track(recover(payload, next)); // recover 内：先记 cooldown，再 await next() 看下游是否认领，最后花自己的 bounded budget
  },
  { global: true, prepend: true },
);
```

同族可用但本仓库未用的 waterfall（均在类型定义中以 @mode waterfall 声明，需要时可按同一形状接入）：

- agent/request（替换冻结的 call config；模型可见内容不可在此改）——D/dsh-agent/lib/types/runtime-types.d.ts:246-263。
- agent/pre-step（拒绝／替换进入本步的消息；调 next() 即保留）——同文件:239-245。
- tools/pre-execute（allow／deny／ask；next()＝委托为 allow）及 around-dispatch 包裹层——D/dsh-tools/lib/types/index.d.ts。
- system-prompt/assemble（对 assembled sections／contexts／tools／variables 的 expert waterfall）——D/dsh-system-prompt/lib/types/index.d.ts:16-27。

注意 llm/stream 的 LOOP 请求是深冻结的（markAgentLoopRequest 身份，内容是 session log 的纯函数——“Agent Note”重构性要求），
监听者只能读不能改（D/dsh-llm/lib/types/index.d.ts:44-52）。

### 2.2 只读／通知事件（emit／serial／parallel：观察，不否决）

- agent 生命周期与收件箱：agent/status（idle⇄running 翻转）、agent/inbox/inserted|claimed|discarded、
  agent/session-start（此处适合 agent.inject() 播种模型侧上下文）、agent/disposed——D/dsh-agent/lib/types/runtime-types.d.ts:160-227。
- turn 边界：agent/turn-stopping（@mode serial，可 agent.steer(...) 反对关闭）、agent/error（@mode emit）——同文件:288-325。
- durable 会话：session/created|disposed、session/event（append 后 fire-and-forget）、session/flush（@mode parallel 并行 durability checkpoint；
  持久化是插件职责：订阅前者、drain 于后者）——D/dsh-session/lib/types/index.d.ts:30-73。
- 反例（本仓库有意不用）：Session.append() 写自定义事件类型而无 ignorable 标记会使持久化重放拒绝重建会话，
  故队列观测只放内存环（W/src/events.ts:1-10）。

### 2.3 Settings section（host 持久化配置）

服务定义：D/dsh-base/node_modules/@deepseek-ai/dsh-settings/lib/types/index.d.ts（注意包是嵌套依赖，
顶层 D/ 下无 dsh-settings 目录；file 实现见 D/dsh-settings-file/lib/types/index.d.ts）。

- 两档注册：settings.register(ns, schema, {base?, applies?, validate?})（自有命名空间，owner fiber 释放即移除——:206-216）；
  settings.installSection(owner, ns, schema, entry, hooks)（可选依赖：有 provider 时以 composition entry 为 base 注册，
  无 provider 时回落到 entry——:217-228）。本仓库用后者（W/src/visibility-settings.ts），无 settings 的部署也能加载。
- 解析顺序：schema 默认 → composition base → user 文档层（:2-7）。读：scope.get()/watch()（:84-96）。
- 写三档：update(patch) 合并、replace(section) 整替（replace({}) 即重置）、
  mutate(ops) 路径寻址（持有残缺／脱敏视图的调用者唯一安全写道——:269-282）。
  本仓库写全部走 mutate＋expectedRevision，冲突码 SETTINGS_CONFLICT（W/src/visibility-settings.ts:14-18,32-47）。
- 命名空间必须小写连字符标识（SettingsNamespaceInput 类型约束——:15-19）；重复注册 loud 失败。
  本仓库命名空间 llm-ctl，schema 为 {providers: dict(bool), models: dict(bool)} 全空默认（W/src/visibility-settings.ts:23,123-128）。

### 2.4 HTTP 路由（第三方插件唯一的浏览器通道）

- webServer.register({kind:'exact'|'prefix', path, handler}) 返回 disposer；重复（kind,path）抛错；
  fallback 席位独立（registerFallback）；index 注入另有 webserver/index-inject emit 事件——D/dsh-host-webserver/lib/types/index.d.ts:64-120。
- 服务只在 web profile 存在，故注入是可选的，headless 可加载（W/src/index.ts:343-389）；
  路由 shapes 以 WebRoute 接口表达（W/src/routes.ts:17-27），state／cancel／visibility／discover 五条 exact 路由（W/src/routes.ts:71-80）。
- 关键否定结论：第三方 Typert Remote 命名空间到不了浏览器——浏览器代理按已知命名空间逐个生成，
  第三方命名空间从不出现在 ctx.remote 上；插件浏览器通道只能是 webServer 上的 plain HTTP
  （同样走该接缝的先例：@linxin666/dsh-doctor——W/src/routes.ts:1-11）。

### 2.5 工具／命令／MCP

- 工具：ctx.tools.register(definition: ToolDefinition)（D/dsh-tools/lib/types/index.d.ts:602），以 defineTool 构造
  （D/dsh-tools/lib/types/schema.d.ts:239）；执行管线有 pre／guard／around／post／result 包裹点。
- 命令：CommandRuntime.register({name, description, input?, recordInput?, handler})（D/dsh-commands/lib/types/index.d.ts:35-50,87）；
  纯上下文定义全局有效，agent 上下文影子内的命令注入子可按 agent 遮蔽全局。
- MCP：每个 server 一个 @deepseek-ai/dsh-mcp-client 插件实例（web profile cordis.patch.yml 即两例：codebase-memory-mcp／chrome-devtools；
  工具名 mcp__<serverName>__<rawName>，serverName 限 [A-Za-z0-9_-]{1,32} 且跨实例唯一——D/dsh-mcp-client/lib/types/index.d.ts）。
- 本仓库未用以上三者（只需要准入＋恢复＋可见性），列此仅为完备性。

### 2.6 Host 读侧 API（本仓库在用的非事件接缝）

- ctx.get('llm') structural 读取 listProviders()/listModels(provider)（兜底目录）与
  listConfigurableProviders()/discoverModels(settingsNs, req, signal)（上游发现，走已存 credential，client 永不碰 secret——W/src/discover.ts:1-10）；
  官方类型 D/dsh-llm/lib/types/index.d.ts:277-299，remote 侧 D/dsh-llm/lib/typert.remote-client.d.ts:10-16。
- ctx.get('agentDefaultModel') 的 currentSelection()/saveSelection() 用于隐藏默认模型时搬 fallback
  （新 agent 在创建时读该选择，故此处是唯一会 strand 新会话的地方——W/src/index.ts:296-335；
  默认种子 deepseek-official/deepseek-v4-flash 见 D/dsh-base/cordis.patch.yml 的 agent-default-model 行）。
- 通用模式：可选服务一律 ctx.inject([name], cb) 延迟挂载＋ctx.effect(dispose) 释放（webServer 见 W/src/index.ts:346-389），
  同步试探一律 try/catch 包 ctx.get（llm 见 W/src/index.ts:233-245）。

## 3. Client 侧扩展点

### 3.1 dsh.client 发现机制（client 插件的出生证明）

三件套缺一不可（以本仓库为最小例子，W/package.json:8-30）：

1. exports[./client] 指向浏览器 bundle（lib/client.js）；
2. dsh.client: { platform: 'web', inject: [...] } 声明平台＋包级依赖边；
3. bundle 本体是 window.__ModuleLoader__.load({ id, factory }) 信封，factory 形如 (require) => exports
   （W/scripts/build-client.mjs:60-69），且必须导出 apply（构建脚本用 stub require 沙箱求值做形状校验——同文件:46-58）。

官方侧证据：

- node 半部（D/dsh-client-modules/lib/types/index.d.ts:1-30）：扫描 host Loader entries 中声明 dsh.client 的包，
  按模块图定序组成 window.__DSH_BOOT__ entry graph，提供 combo script 路由、index 注入行与 clientModuleHost 服务（HMR node 半部）。
  扫描是增量的（per cordis internal/plugin emission 脏标记＋microtask flush），元数据按 Loader specifier 缓存至重启。
- wire 契约（D/dsh-client-modules/lib/types/client/manifest.d.ts）：WebBootEntry{id,url,rev,inject?,immediately?,external?}（:38-59）；
  immediately＝stage-one 预取，inject＝factory 到达先后的包边（cordis 用同一包边做 entry 组合），
  external＝精确的非注入模块请求；stripClientSuffix 把 <id>/client 与裸包名归一为同一 exports（:130-138），
  故 bundle 里 require('@deepseek-ai/dsh-client-ui-settings-models') 与 /client 子路径等价。
- 对照：官方 client 包同样声明，如 D/dsh-client-ui-settings-models/package.json
  （dsh.client.inject=[ui-settings, client-locale, api-remotes]）与 D/dsh-client-ui-model-selection/package.json；
  D/dsh-client-modules/package.json 自带 immediately:true＋空 inject。
- 本仓库的 inject（W/package.json:25-28）：@deepseek-ai/dsh-api-remotes（browser remote 面）与
  @deepseek-ai/dsh-client-ui-settings-models（slot 类型声明宿主——slot 类型住在声明者包里，见 3.2）。
- 运行时 lazy CJS 模型（同 manifest.d.ts 头注释）：执行 bundle 只注册 factory（含 CSS 注入在内的副作用全在闭包里），
  首次 import/require 才 materialize 并 memoize；缺席 specifier 直接 throw（构建期 bundle 纯度门控的运行时镜像）。

### 3.2 Slot 系统（client UI 的官方声明式扩展点）

- 类型层：各包以 declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { 'slot.name': {kind, scope, owner?} } }
  合并声明（slot 类型住在声明者包——见 D/…/slot-contract.d.ts:15-19 的 TYPE HOME RATIONALE）。
  kind：single（占位即替换）／list（有序加法）／keyed（按 entryKey 分发，如 provider-card 按 settingsNs）；
  scope：root／session／session-maybe。
- 运行时：SlotRegistry（D/dsh-client-ui-renderer/lib/types/client/registry.d.ts）——register(options, component) 是唯一注册 API，
  经调用者 ctx.effect 托管（fiber 卸载即级联卸除；必须是 prototype 方法以绑定调用者 ctx——注释明示）；
  slots.inject(slotKey, cb) 为声明等待器（目标 slot 声明到达才执行回调，激活顺序不敏感——D/dsh-client-ui-settings-models/lib/types/client/index.d.ts:27-33）。
- 本仓库范式（W/src/client-plugin.ts:650-676）：footer 座位立即注册；provider-card 座位等 /api/llm-ctl/state 返回
  configurableProviders 目录后再按 settingsNs 去重注册（共享命名空间如 llm-pi-ai 只注册一次，行级 provider 由 owner props 解析——resolveSeatProvider，同文件:594-597）。
- 释放：client apply 返回的 effect 拆定时器／observer／订阅（W/src/client-plugin.ts）。
最小接入示例：
```ts
// W/src/client-plugin.ts:650-656 —— footer 座位（list，加法）
slots.inject('settings.models.footer', () =>
  slots.register({ name: 'settings.models.footer', id: 'llm-ctl-visibility', order: 100 }, FooterSeat),
);
// W/src/client-plugin.ts:668-675 —— provider-card 座位（keyed，按 settingsNs，一族一注册）
slots.inject('settings.models.provider-card', () =>
  slots.register({ name: 'settings.models.provider-card', key: entry.settingsNs }, makeProviderCardSeat(entry.provider)),
);
```

### 3.3 本仓库在用的两个 seats（settings.models）

声明（D/dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts）：

- settings.models.provider-card：kind:'keyed', scope:'root'，owner={provider: ProviderDirectoryEntry, configured, keyConfigured}；
  每个渲染目录行的卡片（含首跑 setup 姿态与 add-provider 草稿卡——草稿未存无 dispatch）都会以 entryKey=settingsNs 分发；
  无注册者时该区渲染空。companion 插件按 adapter 家族命名空间注册一项即可收到该家族全部卡片。
- settings.models.footer：kind:'list', scope:'root'，owner 为空（children?: never）；行与 add 控件之后的有序扩展区。

宿主 props（D/…/ModelsSection.d.ts:15-42）：inject 面（controller／hooks.snapshot／operations／schema／t）＋必选的
子 slot dispatch 座（PropsRenderSlots<'settings.models.provider-card'|'settings.models.footer'>）；渲染器在 render call 处绑定，
直接渲染而漏传会在编译期失败。

### 3.4 Slot 全目录（除 settings.models 外可用的官方座位）

| 座位 | kind／scope | 语义 | 来源 |
|------|-------------|------|------|
| root | single／root | 整棵渲染树根，被 ui-layout AppFrame 占据。勿注册：动态注册项优先级更低反而胜出，会整页只剩你的组件 | D/dsh-client-ui-renderer/lib/types/client/registry.d.ts（DO NOT register 警告） |
| shell.overlay | list／root | 全帧浮层，点击穿透（条目自行 opt-in pointer-events）。badge／toast／status pill 应来此 | D/dsh-client-ui-layout/lib/types/client/index.d.ts |
| sidebar／conversation／details | single | 整列占位；注册即替换整列并带走其声明的子座 | 同上 |
| sidebar.workspaces／sidebar.settings／sidebar.footer.action／sidebar.brand.* | single／list | sidebar 列内的洞；往 sidebar 加东西应进这些内座而非 sidebar 本体 | D/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts |
| settings.trigger/header/action/close/section、settings.plugins.tab、settings.onboarding、settings.general.item | single／list | 设置壳：trigger 行、标题、header 动作、section 页面（一页一注册，id/order/label 导航身份）、插件 tab、onboarding 步、general 单行 | D/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts |
| conversation.session[.header[.lineage\|.actions]]、composer／input 座（含 conversation.input.model）、attachment 座 | single 等 | 会话面；model-selection 在此只做 occupant（见 3.5） | D/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts |
| chat：conversation.chat.node（keyed 渲染器）、conversation.chat.commandview、turn-tail／assistant-action 扩展链 | keyed 等 | 消息／turn 渲染扩展 | D/dsh-client-ui-chat/lib/types/client/contract/slots.d.ts |
| trajectory、tool、workspace、approval、session、jobs、skill、goal、plan、reference、user-questions、workflow-run、deliverables、cordis 等 | 各包自声明 | 各自 feature 面的扩展座 | 各包 lib/types/client/**/slots.d.ts＋index.d.ts 的 declare module …SlotMap（grep interface SlotMap 在 D/ 下共 16 处） |

### 3.5 Model 菜单座位（composer seat 与 /model 弹窗）

- @deepseek-ai/dsh-client-ui-model-selection 只贡献 occupant，不拥有 SlotMap（D/…/model-selection/lib/types/client/slots.d.ts 头注释）；
  目标 conversation.input.model 座由 ui-conversation 的 composer-bar 条目声明并定型，注入面 ModelSelectInjected{available, directory, load, select}。
- 插件 inject 含 dsh-api-session-controller、client-locale、ui-commands、api-remotes
  （D/dsh-client-ui-model-selection/package.json），apply 挂载 ModelDirectoryResolver、注册 model 词典、/model 弹窗贡献与 composer 座位
  （D/…/model-selection/lib/types/client/index.d.ts）。
- 没有官方的“模型菜单过滤”扩展点——这正是本仓库被迫走 DOM hack（X1）的原因。

### 3.6 Client remote 读侧

client inject = ['slots','remote','remote.session']（W/src/client-plugin.ts:39）；
经 ctx.remote.session.modelCatalog() 取忠告的 catalog（30s TTL 轮询），
经 ctx.remote.llm.listConfigurableProviders() 取可配置目录（W/src/client-plugin.ts:92-103,111,679-690）；
llm remote 方法全集见 D/dsh-llm/lib/typert.remote-client.d.ts:10-16。写侧一律走自家 HTTP 路由（2.4）。

### 3.7 静态模块表／React 外置规则与 HMR

- bundle 外置表（W/scripts/build-client.mjs:20-31）：react、react/jsx-runtime、react-dom(/client)、@deepseek-ai/cordis、dsh-client-store、dsh-client-ui-slots、dsh-client-ui-primitives 留给浏览器静态表，
  其余相对导入内联。语义依据：external 若是静态表名则不产生图边（D/dsh-client-modules/lib/types/index.d.ts:47-49）。
- shell 侧静态表种子清单（create({staticModules}) 到底预置了哪些 specifier）待验证——web-frontend 包内未找到 d.ts 证据，
  当前以外置表＋require('react') 能跑为事实（W/src/settings-ui.ts:1-10、W/src/discover-ui.ts:1-10 注释）。
- HMR：host 由 ClientModuleRegistry（rebuilt 上报 bundle 变化）＋ dsh-client-hmr（inject=[clientModuleHost, webServer]，
  pollIntervalMs 默认 500 的 bundle stat 轮询＋SSE 通道——D/dsh-client-hmr/lib/types/index.d.ts）组成；
  browser 按 rev/url 重取 revisioned combo 端点（manifest:86-99）。
  注意 base 默认 hmr.disabled=true（D/dsh-base/cordis.patch.yml）；client-plugin 改动走哪条 watcher 生效待验证。

## 4. Profile 组装层（P1）

- 根是空数组（cordis.yml 头注释：composed as patches: each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays. Edit cordis.patch.yml, not this file）。
- 顺序：web profile package.json 的 dsh.profile.bundles（dsh-base → dsh-web-app → 第三方／本仓库共 14 项，其中
  @leaves615/dsh-llm-ctl 以 link: 本地路径接入）→ 各包 dsh.bundle.patch（如 D/dsh-base/package.json、D/dsh-web-app/package.json 的 dsh.bundle.patch=./cordis.patch.yml，
  base 包自述“substance is cordis.patch.yml”——D/dsh-base/lib/types/index.d.ts）→ 本 profile cordis.patch.yml（MCP 两例）→ --patch overlay。
- 语义（D/dsh-base/cordis.patch.yml 头注释）：每 bundle 一次 insert，后层按 id 覆盖整行（whole-config replace，非合并，
  故某行配置分 mode 就必须每 mode bundle 重述完整版）；行序无加载语义（激活是 service-availability 驱动）；同 id 最后写入获胜。
- 本仓库 host 半部只用一行 insert（W/cordis.patch.yml:5-7：id: llm-ctl, name: @leaves615/dsh-llm-ctl——config 默认即够用）；
  注释明示浏览器半部经 exports[./client]＋dsh.client 声明被发现（C1）。

## 5. 官方扩展点 vs DOM hack（X1）对照

| 维度 | 官方（C2/C3、H1/H2/H5/H6） | 本仓库 DOM hack（X1） |
|------|---------------------------|----------------------|
| 机制 | slot 注册／waterfall／settings／HTTP 路由 | 读 div[role=menu]→section[role=group]→[role=menuitemradio]，display:none 藏行，MutationObserver＋1s 轮询对账（W/src/client-plugin.ts:678-690,700-703；常数 W/src/client-plugin.ts:105-113） |
| 契约稳定性 | 类型＋文档保证（SlotMap／@mode／schema） | 仅依赖“稳定 ARIA／role 契约”——popup 的 hashed class 前缀每构建必变，只能 [class*=...] 模糊匹配（W/src/menu-filter.ts:1-11）；菜单 aria-label 含中英文双语关键词（model／推理等级／effort，W/src/menu-filter.ts:57-61,111-121）；行名取 title→[class*=modelName]→textContent 三级回退（W/src/menu-visibility.ts:40-51） |
| 脆弱点 | 覆盖行整替、路由重名抛错等均为 loud 失败 | Silent 失败为主：选择器失效＝过滤无声消失；label 改名／role 重构＝整功能丢失；与外来搜索插件（dsh-model-search-plugin）同菜单抢 display 控制权，需 hide-only＋data-marker 妥协（W/src/menu-visibility.ts:1-12）；旧 banner 曾用 z-index: 2147483000＋fixed 定位硬浮，现已迁入 conversation.composer.dock 官方槽（W/src/queue-dock.ts 纯视图，W/src/client-plugin.ts 以 order 1000 注册居末，idle 返回 null） |
| 出路 | 若官方日后开出模型菜单过滤 API，第一时间迁移；此前把选择器收敛在 menu-filter.ts 一处即是正确止损 | 同左 |

## 6. 与 @leaves615/dsh-llm-ctl 的对应关系

| 本仓库用法 | 扩展点编号 | 状态 |
|------------|-----------|------|
| llm/stream 准入队列＋终端失败 cooldown（W/src/index.ts:131-160，refusalChunk finish/error 形） | H1 | 官方 |
| agent/request-error 先记 cooldown 再委托下游、后花自有预算（W/src/index.ts:163-231） | H2 | 官方 |
| llm-ctl settings section 两表＋mutate＋revision（W/src/visibility-settings.ts） | H5 | 官方 |
| agentDefaultModel fallback 搬移（W/src/index.ts:296-335） | H8 | 官方服务读侧（structural typing，无硬依赖） |
| webServer 五路由＋browser fetch 轮询（W/src/routes.ts，W/src/client-plugin.ts:105-113,679-690） | H6／C6 | 官方（第三方唯一浏览器通道） |
| llm.discoverModels/listConfigurableProviders 上游发现（W/src/discover.ts:138-195） | H8 | 官方 |
| dsh.client＋./client＋ModuleLoader 信封（W/package.json，W/scripts/build-client.mjs） | C1／C7 | 官方 |
| settings.models.footer＋按 settingsNs 的 provider-card（W/src/client-plugin.ts:561-676） | C2／C3 | 官方 |
| 模型菜单过滤／搜索框／空态（W/src/menu-filter.ts，W/src/menu-visibility.ts） | X1 | 非官方 DOM hack（无官方座位可用） |
| 队列座位（W/src/queue-dock.ts 纯视图＋W/src/client-plugin.ts QueueDockSeat，order 1000 居末，idle 返回 null） | C4（conversation.composer.dock，list／session） | 官方 |

## 7. 不建议／易踩坑点

1. 不要 replace settings 整节（会删掉脱敏视图没见过的 secret 字段）；一律 mutate＋expectedRevision，冲突按 SETTINGS_CONFLICT 重读再写（依据：settings 类型注释:269-282＋W/src/visibility-settings.ts:14-18）。
2. 不要写 llm/stream 里 LOOP 请求的 options（深冻结，写即抛）；只读＋短路／透传（D/dsh-llm/lib/types/index.d.ts:44-52）。
3. agent/request-error 必须先 await next() 再花自己的预算，否则抢掉下游重试执行器（本仓库 recover 顺序即规范——W/src/index.ts:163-183）。
4. webServer 视为可选：headless composition 无此服务，ctx.inject(['webServer']) 回调永不执行也须正常加载（W/src/index.ts:343-346）。
5. 路由（kind,path）重名抛错是组合层契约——第三方路径加自家前缀（如 /api/llm-ctl/…），勿占通用名（D/dsh-host-webserver/lib/types/index.d.ts:83-90）。
6. settings 命名空间／命令名／MCP serverName 均有命名约束（小写连字符／小写无斜杠／[A-Za-z0-9_-]{1,32} 唯一）；重复注册 loud 失败，写前先查。
7. 勿注册 root single 槽（动态项反而胜出，整页被换——D/dsh-client-ui-renderer/lib/types/client/registry.d.ts）；浮层需求进 shell.overlay（list，加法）。
8. client bundle 只能 require 静态表成员；未知 specifier 在 materialize 时 throw。新增 npm 依赖先确认是否在外置表，否则打包内联（W/scripts/build-client.mjs:20-31）。
9. client inject 漏写会被静默饿死：slots／remote 不在 inject 里，apply 拿到的 ctx 就没有它们（W/src/client-plugin.ts:38-39 的反面）。
10. provider-card 座按 settingsNs 注册、按行 provider 解析：共享命名空间的多行（pi-ai 系）若用注册闭包 id 会串台，必须读 owner props（W/src/client-plugin.ts:599-607 血泪注释）。
11. patch 行是整替：覆盖官方行（如 tools mode）必须重述全部键，只写差量键会丢默认值（D/dsh-web-app/cordis.patch.yml 头注释）。
12. DOM hack 侧：aria-label／role／[class*=modelName] 任一变化即 silent 失效；与 dsh-model-search-plugin 同菜单时只可 hide-only（W/src/menu-visibility.ts），不可重写 display；1s 轮询＋全子树 observer 是当前最大性能税，slot 化后应删除。

## 8. 待验证清单（未找到一手证据，勿当 API 用）

- shell staticModules 种子清单（哪些 specifier 可被 require）——web-frontend 下无 d.ts 证据。
- client-plugin 改动的 HMR 生效路径（dev watcher 链）——base 默认 hmr disabled，本 profile 未显式启用。
- dsh-api-remotes 的按命名空间生成代理的具体 roster（只知第三方命名空间不到浏览器——W/src/routes.ts:1-11）。
- dsh.profile.bundles 之外的 profile 字段（如 dev 覆盖、路由前缀定制）是否存在。
- settings.section（host 侧 section 注册）与 client settings.section slot 是否存在官方桥接（Models 页是手写 page，非自动桥）。

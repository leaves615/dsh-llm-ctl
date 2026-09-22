# Rate-limit 调研·主会话汇总（DSH 本地源码核实 + vendor 报告交叉）

> 完整 vendor 对照表（13 家，一手核实）见 **vendor-rate-limit-report.md**；本文件只保留 DSH 本地事实与对 dsh-llm-ctl 的落地结论。

## 1. DSH 现状（本地源码核实，@deepseek-ai/* 0.1.2-rc.1）

- 稳定失败码：RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE / AUTH / INVALID_CREDENTIAL / QUOTA / INVALID_REQUEST / CONTEXT_WINDOW_EXCEEDED / NO_ADAPTER；默认可重试集 = EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT（dsh-llm lib/index.js:217-221）。
- dsh-llm-deepseek：429→RATE_LIMIT、401/403→AUTH、413→INVALID_REQUEST、400→INVALID_REQUEST 或 CONTEXT_WINDOW_EXCEEDED、>=500→SERVER；providerRetryAfterMs() 把 Retry-After 解析为「整数秒×1000」或「HTTP-date 差值」挂进 details（lib/index.js:1493-1522,1786-1791）。
- dsh-llm-pi-ai：消息正则 /429|rate.?limit/i → RATE_LIMIT（lib/index.js:1294），无 header 解析。
- 排队缝：ctx.on("llm/stream", …, {global, prepend})（dsh-session-title lib/index.js:262 同款）；后台任务（session-title、compaction-basic:303）与 agent-loop（agent-loop:624）全部经 ctx.llm.stream() → 前置 listener 一网打尽。
- **adapter 均不透出原始响应头**（deepseek 只给解析后的 providerRetryAfterMs）→ 阶梯 2-6 级统一依赖同一个上游增强：LlmError.details.headers 透传（一个 issue 解锁全部）。
- 失败到达形态两种：dispatch 抛 LlmError（HTTP 错误，首 chunk 前）或流中 terminal finish chunk{kind:'error'}（adapterFailureChunk，dsh-llm lib/index.js:1743）；OpenRouter 上游 429 即以 SSE 块在流中到达（vendor 报告·陷阱6）。

## 2. 落地结论（已并入 PRD §6.1）

- 语义归类：429=限流入队；529/503=过载短退避（DSH 已归 SERVER，覆盖 OpenAI/Anthropic/DeepSeek/Gemini/Together/OpenRouter）；402/403=配额/计费**不排队**（DSH QUOTA/AUTH），UI 暂停并告警；Bedrock ThrottlingException=429（botocore 核实）、ServiceQuotaExceededException=400 配额不退避。
- 延迟阶梯（全归一毫秒）：retry-after-ms/providerRetryAfterMs → Retry-After（秒|HTTP-date）→ x-ratelimit-reset（Together 秒）→ Go 时长串（OpenAI/Groq）→ anthropic RFC3339 reset → body code 白名单 → 本地退避。MVP=第1级（deepseek）+ 本地退避；2-6 级等 details.headers 透传（M4）。
- 无 Retry-After 厂商（必走本地退避）：DeepSeek、Gemini、SiliconFlow、阿里百炼、火山 Ark（未核实）、Mistral（未核实）、Bedrock（未核实）；Together 仅有 x-ratelimit-reset；Azure 例外优先 retry-after-ms。
- body code 白名单（分类/兜底 pi-ai 正则）：rate_limit_error、rate_limit_exceeded、slow_down、RESOURCE_EXHAUSTED、ThrottlingException、ModelNotReadyException、dynamic_request_limited/token_limited、RSC 20012、百炼三文案。
- 主动节流（远期）：Groq 每响应带 x-ratelimit-*，OpenAI/Anthropic 成功响应也带 → 429 前预测性节流；需 adapter 透传成功响应头。
- 流式陷阱：排队冷却登记必须同时覆盖 dispatch 抛错与流中 terminal finish chunk 两种形态。

## 3. 仍未核实

- OpenRouter X-RateLimit-Reset 的单位（秒 vs epoch）——保留 epoch 启发式（数值>3600 视为 epoch）。
- 火山 Ark 错误码页（JS 渲染）、Mistral 限流页（404）、Bedrock x-amzn-Retry-After。

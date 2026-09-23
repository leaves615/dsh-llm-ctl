# 主流 LLM API Rate Limit 形态调研（@leaves615/dsh-llm-ctl 排队设计依据）

> 后台调研 agent 一手核实报告（2026-07，仅官方文档 / botocore 规范 / 官方 SDK 源码；[未能核实] = 站点不可达，未采信二手转述）。主会话交叉核对记录见 rate-limit-survey.md。

## 一、厂商对照表

| 厂商 | 状态码 | 关键响应头 | body code/type | 限流维度 | Retry-After |
|---|---|---|---|---|---|
| OpenAI | 429（限流+ramp-rate）；503（过载）；计费上限也走 429 | Retry-After（整数秒）、x-ratelimit-limit/remaining-requests、x-ratelimit-limit/remaining-tokens、x-ratelimit-reset-requests/tokens（时长串如 6m0s），另有 project 级变体 | rate_limit_error+slow_down；service_unavailable_error+server_is_overloaded；历史计费 429 用 invalid_request_error+rate_limit_exceeded | RPM/RPD/TPM/TPD/IPM + 突增 ramp-rate | 有（429 临时限流与 503 过载，官方称"最小等待时间"） |
| Anthropic | 429；529 overloaded_error；spend-cap 429；自设限额走 400 | retry-after（整数秒，spend-cap 429 不带）、anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}（reset 为 RFC 3339 绝对时间）、x-should-retry | rate_limit_error（429）、overloaded_error（529）、invalid_request_error（400 限额） | RPM/ITPM/OTPM 按模型分级；Workspace 子限额；月 spend cap | 有（普通 429；spend-cap 429 无，SDK 会一直失败） |
| DeepSeek | 429（并发超限）；402 余额不足；503 服务器过载；422 参数错误；400 鉴权/格式 | 官方未记载限流专用头 | 官方 errors 页只按状态码描述，未给 code 枚举 | 并发数按模型分级（pro 500 / flash 2500），user_id 隔离 | 无 → 指数退避 |
| Gemini | 429 RESOURCE_EXHAUSTED；503 UNAVAILABLE（过载） | 文档未记载 retry-after 类头 | RESOURCE_EXHAUSTED（429）、UNAVAILABLE（503） | RPM/TPM/RPD 按模型×层级（Free/Tier1-3）；spend-based 限流按 10 分钟滚动窗口 | 未记载 → 官方建议指数退避 |
| OpenRouter | 429（平台限流或上游转发）；402 余额不足；503 无可用 provider；529 Overloaded | X-RateLimit-Limit/Remaining/Reset（仅平台限流 429 响应）；上游 provider 给出重试提示时带 Retry-After；成功响应不含限流头 | error.code=429 + metadata.error_type="rate_limit_exceeded"；流式中以 SSE 块 finish_reason:"error" 送达 | 平台层免费模型 RPM/RPD（20/min；50/天无充值、1000/天有充值）+ 各上游 provider 限流 | 有（条件性：仅当上游返回重试提示） |
| SiliconFlow 硅基流动 | 429；503；504；401/403 | 未记载 retry-after 类头 | RSC 错误码 20012："Requests ... exceeded the rate limiting ... Details: TPM limit reached" | 账户等级→RPM/TPM 分级（如 Chat 1000-10000 RPM / 50万-500万 TPM；按模型族） | 未记载 → 官方建议指数退避+客户端限速 |
| 火山引擎 Ark | [未能核实]（错误码页 JS 渲染不可抓取；社区普遍称 429 FlowLimit） | [未能核实] | [未能核实] | 按模型限流（同主账号同模型不分版本，方舟设定）；官方"突发流量处理最佳实践"主张客户端排队 | [未能核实] |
| 阿里云百炼 | 429（限流）；403（免费额度耗尽"用完即停"） | 未记载 retry-after 类头 | 429 文案区分：Requests rate limit exceeded（RPM）、Allocated quota exceeded（TPM）、Request rate increased too quickly（突增保护） | 主账号级（RAM/空间/Key 合并）按模型 RPM/TPM；部分模型动态限流；Batch 不限 | 未记载 → 官方建议匀速调度/队列/指数退避；通常 1 分钟内恢复 |
| AWS Bedrock | **429** ThrottlingException 与 ModelNotReadyException；**400** ServiceQuotaExceededException；503 ServiceUnavailableException；424 ModelError/StreamError | 官方错误规范未定义 Retry-After 头；x-amzn-Retry-After [未能核实] | botocore service-2.json 错误形状名：ThrottlingException、ServiceQuotaExceededException、ModelNotReadyException、ServiceUnavailableException | botocore 规范不含配额维度；具体 TPM/RPM 见 Service Quotas [未能核实] | 未核实 → SDK 内置指数退避 |
| Azure OpenAI | 429（限流/容量节流均 429） | retry-after-ms（**毫秒**，429 专属）、retry-after、x-ratelimit-limit/remaining-requests/tokens、x-ratelimit-reset-requests/tokens（秒，如 300） | OpenAI 兼容错误 JSON（error.code/message）；文档强调 429 可能来自容量节流而非配额 | 部署级 TPM/RPM；按模型×区域配额；Quota Tiers 1-6；Global/DataZone 共享池；1 秒粒度速率评估 | 有（retry-after-ms 优先；SDK 自动尊重） |
| Groq | 429 | retry-after（整数秒，仅 429 时返回）；x-ratelimit-limit/remaining-requests（对应 **RPD**）、x-ratelimit-limit/remaining-tokens（对应 **TPM**）、x-ratelimit-reset-requests/tokens（时长串 2m59.56s，**每个响应都带**） | 未记载 code 枚举（429 Too Many Requests） | RPM/RPD/TPM/TPD/ITPM/OTPM + 音频 ASH/ASD，按模型×组织层级 | 有 |
| Together | 429（超动态速率）；503（平台容量过载，与用量无关） | x-ratelimit-reset（整数秒，仅 429 时返回）；无 retry-after | error_type: "dynamic_request_limited" / "dynamic_token_limited" | 动态限流：按 org×模型随近期用量浮动，无固定阈值（dedicated endpoint 例外） | 无 retry-after；但有 x-ratelimit-reset（秒） |
| Mistral | [未能核实]：docs.mistral.ai/deployment/rate-limits/ 持续 404，Wayback 无快照 | [未能核实] | [未能核实] | la Plateforme 按层级（tier）限流 [未能核实] | [未能核实] |

## 二、关键一手证据

- **Bedrock 状态码（botocore service-2.json）**：ThrottlingException→429（不走 400）；ServiceQuotaExceededException→400（配额类走 400）；ModelNotReadyException→429；ServiceUnavailableException→503。来源：https://github.com/boto/botocore/blob/main/botocore/data/bedrock-runtime/2023-09-30/service-2.json
- **503 overloaded 广泛存在**：OpenAI（server_is_overloaded）、Anthropic 官方另用 529 overloaded_error、DeepSeek（Server Overloaded）、Gemini（503 UNAVAILABLE）、Together、OpenRouter（503/529）。
- **SDK 对 Retry-After 的解析顺序（openai-python 与 anthropic-python 同构，_base_client.py）**：retry-after-ms（毫秒）→ retry-after（秒，容忍浮点）→ retry-after 作 HTTP-date 解析；OpenAI SDK 超过上限（默认 60s）则放弃重试。来源：https://github.com/openai/openai-python/blob/main/src/openai/_base_client.py 、https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_base_client.py 、https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts（另含 x-should-retry 头处理）。
- 其余来源（正文均已核对）：OpenAI https://platform.openai.com/docs/guides/rate-limits ；Anthropic https://docs.anthropic.com/en/api/rate-limits 与 /en/api/errors ；DeepSeek https://api-docs.deepseek.com/quick_start/rate_limit 、/quick_start/error_codes ；Gemini https://ai.google.dev/gemini-api/docs/rate-limits 、/gemini-api/docs/troubleshooting ；OpenRouter https://openrouter.ai/docs/api-reference/limits ；SiliconFlow https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions 、/docs/userguide/faqs/rate-limit-and-upgradation ；Ark https://www.volcengine.com/docs/82379/1848593 ；百炼 https://help.aliyun.com/zh/model-studio/rate-limit ；Azure https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits 、/en-us/azure/foundry/openai/how-to/quota ；Groq https://console.groq.com/docs/rate-limits （本环境 403，经 web.archive.org 2026-09-05 快照核对全文）；Together https://docs.together.ai/docs/rate-limits 。

## 三、@leaves615/dsh-llm-ctl 归一化建议

**1) 解析优先级（高→低）**
1. retry-after-ms（Azure，毫秒）——最精确；
2. retry-after（整数秒为主；RFC 允许 HTTP-date，需兜底 date 解析）；
3. x-ratelimit-reset（Together，秒）；
4. x-ratelimit-reset-tokens/requests（OpenAI/Groq，Go 时长串 6m0s/2m59.56s——需时长串解析器）；
5. anthropic-ratelimit-*-reset（RFC 3339 绝对时刻，需 clock-sync 换算）；
6. body code 白名单匹配（见下）；
7. 全部缺失 → 指数退避 + jitter。

**2) 状态码语义归类**：429=限流（入队等待）；529/503（overloaded_error、server_is_overloaded、UNAVAILABLE、Server Overloaded）=过载（可短退避重试）；402/403（insufficient balance、免费额度耗尽）=配额/计费（**不排队**，暂停并告警）；400 带 Anthropic spend-limit 文案=不重试；Bedrock 400 ServiceQuotaExceededException=配额（不退避，等提额）。

**3) body code 白名单**：rate_limit_exceeded（OpenAI 历史/OpenRouter）、rate_limit_error（Anthropic/OpenAI）、slow_down（OpenAI ramp-rate）、RESOURCE_EXHAUSTED（Gemini）、ThrottlingException/ModelNotReadyException（Bedrock）、dynamic_request_limited/dynamic_token_limited（Together）、RSC 20012（SiliconFlow）、百炼三文案（Requests rate limit exceeded / Allocated quota exceeded / Request rate increased too quickly）。

**4) 单位统一**：全部归一为毫秒。纯数字 = 秒（retry-after / x-ratelimit-reset / x-ratelimit-reset-*）；retry-after-ms = 毫秒；Go 时长串（s/m 混合）需专用解析；RFC 3339 与 HTTP-date 按绝对时刻换算（注意本机时钟偏差）。

**5) 主动排队信号**：Groq 的 x-ratelimit-* 每个响应都带，OpenAI/Anthropic 成功响应也带 → 可在 429 前按 remaining/reset 提前节流。

**6) 流式陷阱**：OpenRouter 上游 429 会以 SSE 块（finish_reason:"error"）出现在流中，排队层必须解析流中错误。

**7) 无 Retry-After 名单**（必须指数退避兜底）：DeepSeek、Gemini（未记载）、SiliconFlow、阿里云百炼、火山 Ark（未核实）、Bedrock（未核实）、Together（仅有 x-ratelimit-reset）；Azure 例外——优先 retry-after-ms 而非 retry-after。

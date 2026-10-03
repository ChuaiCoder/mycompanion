# Token 预算、估算与提供商用量

更新：2026-10-03。T01 当前为源码实施状态，最终 EXE 和真实指定模型用量验收尚未完成。

## 复用与比较

继续使用已固定的 `gpt-tokenizer@4.0.0`（MIT）的 BPE 表；比较了 OpenAI 官方 cookbook 的消息计数、固定 SillyTavern 1.19.0 的计数接口，以及 Ollama、Claude、Gemini 的用量格式。官方 cookbook 也明确指出消息封装的计数是估算，不能保证模型更新后仍准确。gpt-tokenizer 的 chat/function 估算不能替代这些提供商的服务端计量，因此保持现有酒馆兼容计数约定，公开近似边界并记录响应中的用量。

图片尺寸先比较了酒馆异步浏览器解码器和 `image-size@2.0.2`（MIT）。后续独立 OSV 审计实际发现该包的两条 HIGH 无限循环漏洞，已移除通用 npm 包，改为复用 advisory 指向的固定修复提交中的四个 PNG/JPEG/WebP/GIF handler 和工具/类型，函数体不改。宿主按 MIME 明确选择 handler 并校验 header，最多读64 KiB，不执行像素解码、文件读取或远程下载。完整许可、来源哈希与失败/修复证据见 [依赖安全记录](dependency-security.md)；打包门禁核对版权与编译模块、拒绝通用包。远程图片或异常头部标明未知，不能伪称已测尺寸。不推断新的维护日期或零未知风险。

2026-10-03 再读当前 OpenAI 官方 Markdown sizing/patch/tile 表，并交叉比较 LiteLLM 的 `litellm_core_utils/token_counter.py`。LiteLLM 核心目录为 MIT、enterprise 另有许可；该 helper 将 auto 作为低清默认值，并在高精度时可请求远程图片。完整 Python/httpx/tiktoken 栈和这些默认行为不直接适配本项目，因此只借鉴区分规则、默认未知尺寸与上界的设计，不复制其代码。只取得当时 main 源码与许可，未取得固定 commit 或新的维护日期。项目自行实现官方公开公式，未引入 LiteLLM 依赖；header 改用上述固定 MIT 摘录。

参考：

- [OpenAI 官方 cookbook](https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb)
- [gpt-tokenizer 源码](https://github.com/niieani/gpt-tokenizer)
- [OpenAI 图片计量规则](https://developers.openai.com/api/docs/guides/images-vision#calculating-costs)
- [image-size](https://github.com/image-size/image-size)
- [固定酒馆计数接口](https://github.com/SillyTavern/SillyTavern/blob/7e8663cd9c184a550b37238218bdd32c6efc68e9/src/endpoints/tokenizers.js)
- [Ollama 计数](https://docs.ollama.com/api/chat)
- [Claude 用量类型](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)
- [Gemini 计量说明](https://ai.google.dev/gemini-api/docs/tokens)

## 行为与边界

- `tokenAccounting` 是本地准入估算。`textEstimated=false` 只表示用了已知模型的普通文本 BPE 表；`estimated` 和 `framingEstimated` 仍为 true。Harmony 的普通文本使用 o200k 字表，不把酒馆消息框架说成 Harmony 的精确封装。
- 原生最终计量发生在扩展及 YAML 修改之后，依据实际请求模型、消息、工具、response format 和回复预留；Token 报告标明区域明细可能来自修改前的组装。
- 已核实的 tile 模型按模型 base/tile 和实际内联尺寸计算；4o-mini 不再错用 85。低清按 model base，高/auto 不扩大本来较小的图片。固定酒馆旧实现把 auto 的小图作低清、并无条件放大到短边 768，本项目采用当前官方规则并将差异明示。
- 远程图片的未知尺寸按已核实 tile 规则最多 8 tiles 估算，仍标明未知。已核实的 patch 模型使用32px覆盖、维度限制、缩放预算和模型倍率，按明确模型/日期与 detail 匹配；当前官方表中的5.4低清和高精度具有不同预算，不能套用固定85。未核实的模型/后缀/detail、Claude/Gemini图片、音频和其他内容仍标明未完整计量。估算不保证提供商图像尺寸/30,000 patch输入限制通过。
- Claude 原生 text/thinking/tool_use/tool_result 及 Gemini native text/functionCall/functionResponse 的实际文本进入预算。内联图片使用图片估算，音频标明尚未计量；Base64媒体不会被当普通文本 BPE计数。redacted/未知内容明确不完整。Claude/Gemini文本目前仍使用公开的兼容估算，不能称为原生tokenizer或准确账单。
- `generationMetadata.usage` 仅保存提供商返回的非负安全整数。OpenAI 的 JSON/SSE usage、Claude start/delta、Gemini metadata、Ollama counters 有独立字段映射；累计帧覆盖相应计数，不能重复相加。未知字段、字符串、负数、NaN/Infinity 不进入元数据/备份。
- 提供商输入计数只与 `tokenAccounting.promptTokens` 对比；回复预留和安全余量不参与差額。没有 usage 时保持缺省，不用本地估算伪造服务端计量。官方 api.openai.com 流默认请求 include_usage；其他兼容服务可以通过其真实请求配置传入，避免假定每个兼容服务支持该选项。

2026-10-03 重新读取 Anthropic 与 Google 的官方 SDK 类型及字段说明后，修正了跨协议用量语义：Claude 的 `inputTokens` 是非缓存输入、缓存读取和缓存创建之和，三个原始分类分别保留；后续累计 delta 更新分类再计算，不能重复累加。Gemini 的 `outputTokens` 是 candidates 与 thoughts 之和，候选输出和推理输出另列分类；其 `toolUsePromptTokenCount` 为额外工具结果输入，独立展示。`totalTokens` 只接受提供商实际报告，不从这些分类猜造。计数加和超出安全整数时省略对应归一化值，保留可验证分类。旧归档中未分类的用量不会追溯猜测。上述分类是包含或拆分关系，不能再相加作为费用总量。

HTTP 测试采用受控协议提供商，只证明实际出站、流/JSON 解析、保存和重启往返，不证明真实模型费用或服务端 tokenizer 与本地一致。真实固定模型、工具/多模态、最终候选仍需专项证据。

补充验证：`t01-patch-r1-20261003.log` Token8项通过，核对官方1024平方/2048平方/4096×512三个例子、长条与小图、model/detail边界；`t01-native-results-r1-20261003.log` 两文件30项（Token9、工具HTTP21）通过，包含原生超长工具结果在第二次提供商fetch前被预算拒绝。未知媒体和真实服务端用量对照仍开放，T01暂不勾选。

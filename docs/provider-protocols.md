# 原生模型协议实施

P01 进行中，2026-10-03。协议测试不替代完整生成模式、工具结果续轮、真实模型质量或最终 EXE 门槛。

## 研究与复用

| 实现 | 许可/可观察维护证据 | 复用和适配判断 |
| --- | --- | --- |
| SillyTavern 1.19.0 | 固定提交 `7e8663cd9c184a550b37238218bdd32c6efc68e9`，AGPL-3.0-only；实际读取 prompt-converters 与 Claude/MakerSuite endpoint | 提取四个固定函数声明：Claude转换与两种thinking budget函数体保持原样，Google转换增加一处 `provider_native` 分支以重放原始带签名Part，其余函数体保留。上游账号秘密目录、Express服务与原始错误日志不搬入；使用现有SQLite/safeStorage及安全错误边界。默认配置、typed输入和该分支适配写入来源manifest。 |
| Vercel AI SDK | `@ai-sdk/anthropic@4.0.71`、`@ai-sdk/google@4.0.87` 精确 npm tarball，Apache-2.0；包元数据发布日期 2026-09-30 | 实际读取 native endpoint/header、Claude block/JSON/signature stream、Google functionCall/inlineData/thoughtSignature 与 finish mapping。交叉核对协议与状态机；完整 SDK 的 V4 provider/utility/tool-loop 栈不直接适配酒馆原始请求，暂不安装依赖。源码仅研究，生产转换仍用固定 ST；避免默认自动重试重复成本和第三方工具副作用。 |
| Claude 与 Gemini 官方 API | 文档于本轮可读取：Claude `/v1/messages`、`anthropic-version`/`x-api-key`；Gemini `models:generateContent` / `streamGenerateContent?alt=sse`、contents/systemInstruction/generationConfig | 对照成熟实现的实际 wire 合同。各协议凭据只发送到已选 scope，不把原生源误当 OpenAI；原始错误体不进入消息/日志。没有使用付费模型。 |

SDK 研究目录 `.cache/research/p01-protocols-20261003`。Anthropic tarball SHA-256 `0bf9e927e536d37ad9e47c723e996581afe0ecb282296b1d672c87bbb550d271`，Google tarball `e8a5f5037f28da0b1112991edef551c3f732ef5cfc1fc678e626886da678779c`；包内版本/许可已核对。GitHub raw 两次旧路径返回 404，使用已取得的精确 npm source；未把这些失败或可读取 main 当作新的固定 commit/维护日期证据。

转换生成器 `scripts/import-provider-converters.mjs` 默认只校验，写入须显式 `--write`；源文件 hash 和每个声明/生成输出 hash 见 `apps/local-service/provider-converters-upstream.json`。普通安装/构建/测试无需研究缓存。项目仍为 AGPL-3.0-only，酒馆助手只隔离测试，不进入发行包。

## 源码验证

`p01-protocol-tools-continuation-20261003-r2.log` 六文件38项通过：原生协议12、公开流2、原ToolManager8、continuation5及原PromptManager11。实际HTTP协议验证native headers/endpoints、JSON/SSE reasoning/signature/media/usage、同协议改model和preflight改model时的签名scope；公开流再由原版ToolManager解析工具分片。continued prompt阶段来自固定ST真实函数，前台UI另由实际窗口验收。

`t01-native-results-r1-20261003.log` 两文件30项，工具HTTP21与Token9，另验证三个协议的真实结果续轮、长结果在fetch前被预算拒绝、每轮用量与SQLite/backup/new-port重启及下一次聊天重放。成功消息只保存最终模型轮次正文，前言与真实工具結果留在toolRounds；协议/model变化时剔除旧签名，内部origin标记不进入实际提供商wire或最终预算。controlled提供商不证明付费模型质量、全部输入/音频能力或最终EXE通过，完整P01仍未勾。

## 原生流式坏 JSON 边界

固定 ST `public/scripts/openai.js:3173–3175` 对正常 SSE data 直接执行 `JSON.parse`；坏 JSON 会中断生成。Vercel 的 Claude/Google 流式解码同样将解析失败作为 error。本项目原生解码原先静默跳过坏 JSON，正文或工具调用帧后即使收到坏帧，仍可能在正常终止帧后被保存为 complete，甚至执行已经累积的工具。

`provider-response.ts` 现在对终止帧之前的坏 JSON 抛出固定 `ModelRequestError`（502，`模型返回了不兼容的响应格式。`）。保留已经收到的正文并保存 failed，取消 reader、释放故事生成锁；坏帧后的正文、工具 RPC、成功记忆提取和自动摘要均不继续。非 JSON `event:error` 也不能被忽略。提供商原始 frame、JSON 解析器原始异常及凭据不进入错误、消息、导出、备份或日志。公开扩展传输原有字节保真/错误净化合同没有改变。

有效 before 为 `.cache/reports/p01-malformed-native-before-20261003-r2.log`：两文件39项中9失败、30通过；最小生产修复后的 `.cache/reports/p01-malformed-native-after-20261003-r1.log` 同39项全通过。真实 Node 提供商及宿主 HTTP 覆盖 OpenAI、Ollama 的 OpenAI兼容端点、Claude、Gemini 正文→坏帧→终止，三协议原版 ToolManager 完整工具帧→坏帧→终止零回调，七轮失败零记忆/摘要 HTTP 与 SQLite 记录，下一轮恢复，以及逐字节 UTF-8、SSE comment 和 usage-only 成功控制。此次没有实现 Ollama `/api/chat` NDJSON。

SSE 分帧继续复用 `eventsource-parser@4.1.1`，实际包内许可为 MIT；Vercel 仅研究、许可 Apache-2.0，固定 ST 为 AGPL-3.0-only。本修复不复制新的上游声明、不新增依赖，现有转换来源 manifest 不变。

## quietImage 控制消息

固定 ST `openai.js:1229–1238` 在 quietPrompt 有正文、模型允许图片输入且 quietImage 非空时调用已有 `Message.addImage`；图片随 quiet control 保持最后，并在装载历史之前预留 control 预算。实际开关为 `oai_settings.media_inlining`，默认 true；旧 `image_inlining` 是上游迁移来源，不能当作当前开关。

宿主和 `prepareOpenAIMessages` 已携带 quietImage，使用现有 `model-prompt-image` 将文本与图片保留至宏/正则/PromptManager 处理之后，仅在预算和传输副本中物化。图片计入 media cost，不能把 base64 当文本计数，也不能只因允许字段就跳过预算。关闭 media_inlining 或 quietPrompt 为空时不附图。能力判断复用既有浏览器规则；custom 不新增模型白名单，preflight 改动 source/model 后按本次 normalized snapshot 再校验仍存在的 quiet 图片，未知原生能力明确拒绝并不发送到提供商。

Claude 固定转换器将 leading system.content 原样提取为 native text；空故事的图片控制因此可能产生非法 system.text 数组。自有协议边界仅将 native leading system 中含 image_url 的控制保留为 user 内容轮次，保持文本 system 和非leading消息角色；OpenAI 保持原 system 图片控制。Google 原转换保留最后一条 system 控制为 user，测试按这一真实行为断言；图片保持 inlineData，不进入 systemInstruction.text。没有修改固定提取的转换函数或其 hash。PNG Data URI 的原 base64/MIME 进入 Claude image.source 和 Gemini inlineData；OpenAI detail 与 Gemini3 mediaResolution 使用既有转换。

本轮 `.cache/reports/p01-quiet-image-native-http-20261003-r5.log` 六文件80项通过，含 quietImage 专属15项：三协议真实 wire、有/无历史、普通 system 控制，媒体预算超限零提供商/变量写入，两宏引擎 dryRun 与公开 assembly 零聊天/local/global变量写入，关闭图片（含其他 falsy 设置值）/空 quiet 条件，preflight source/model与不完整媒体估算，以及真实取消和下一请求恢复。另执行实际 served settings/prompt/collection 字符串，通过真实 assembly HTTP 核对 quietImage 与图片质量参数；VM 接线是宿主源码回归，不能替代打包后浏览器 ESM/DOM 验收。

Claude/Gemini 图片预算仍按现有未知媒体规则估算并公开 `complete:false` / `unknown-image-model`；没有把本地估算当作提供商计费。此轮未复刻 ST 的远程图片下载/压缩流程：使用既有 Data URI/URL 传输合同，Gemini 仍要求内嵌图片，Claude 可用其现有 URL source。forceChId/群组覆盖和此前未支持的工具/推理/生成媒体公开 assembly 入口仍诚实拒绝。本轮源码测试不等于完整 P01/T01、真实模型或新候选 EXE 已通过。

## OpenAI/custom 原生多候选首批

本批处理前台 OpenAI/custom 请求中的原生 `n` 和实际返回的 `choice.index`，复用酒馆 `swipes`、`swipe_id`、`swipe_info` 数据形状。原先 JSON 取数组第一条，SSE 每帧取第一条，乱序多候选会分别保存 B 或混成 B1A2。现在按提供商序号独立累积正文、reasoning/signature、媒体、工具序号和 finish reason，选中序号 0；缺少 0 时保存失败与实际收到的其他候选，`swipe_id=-1`，不会把候选 1 当成 0。稀疏序号由 Map 管理，落库数组按序号排序，公共 swipe slot 与提供商 index 分开。可选 `n:null` 沿用 OpenAI 请求合同，不另加候选数量上限。

研究使用前述固定 ST 提交。`openai.js:2774–2788` 限定 multiswipe 来源，`:2840` 在不能 multiswipe 时才自动注册工具；原 ToolManager 将 `[choiceIndex][toolOrdinal]` 分层，实际 invoke 只取 0。本地解析采用相同分层及执行选择；多个候选可以拥有相同工具 ordinal/id 而互不覆盖。工具续轮重新建立候选图，消息只保存最后一轮候选，已执行轮次的前言、用量与结果保留在 request-level `toolRounds` 审计。ST `:3177` 的流式首项选择以及共享 reasoning 的 FIXME 未作为兼容目标复制。Vercel 上述固定 Claude/Google 包和所读取 `@ai-sdk/openai@4.0.83` 同样采用单结果，无法直接提供此宿主候选持久化；OpenAI 源码来自只读 unpkg，未声称 npm tarball 完整性验证或安装 SDK。项目许可仍为 AGPL-3.0-only，无新增依赖、上游声明或许可证改动。

每个候选的私有 `swipe_info[slot].extra.__mycompanion_native_candidate` 保存 version、提供商 index、处理后正文快照、status、finish reason/outcome 和独立 responseState。共享校验器只投影结构有效且正文未修改的当前候选；手改正文或破坏 info 会清除旧显示/签名状态。切到非 0 候选也不能重放 0 的工具历史。提供商 usage、本地 tokenAccounting 与已执行 toolRounds 仍由宿主保存一份，扩展回传的 generationMetadata/status 不能覆盖请求计费。已解析 JSON 的候选随后出现重复序号时，保留此前合法候选及提供商实际 usage，拒绝重复候选；坏响应不继续执行工具或成功记忆任务。

宿主生成元数据另保留只允许 true 的 `nativeCandidates` 历史标记，原生候选落库时写入，扩展保存沿用 previous 宿主值，并为仍有旧候选 marker 的消息补齐该标记。共享 helper 同时识别 extra 的私有镜像和 swipe_info；删除整个 swipe_info，甚至删除全部扩展可编辑 marker，都不能把原生消息降格为 legacy 而借用旧 responseState/toolRounds。候选 info 已缺失时清显示状态，usage 与实际工具审计保留，下一模型请求不重放这些工具、旧签名或媒体；真正无 native 历史的 legacy 消息保持现有行为。真实 HTTP 删除边界的独立 before/after 见 `p01-native-candidates-deleted-info-before-20261003-r1.log` / `p01-native-candidates-deleted-info-after-20261003-r1.log`：先两项失败，再两项通过，含伪造 raw flag/用量、SQLite 重启与下一实际提供商请求。

output 正则沿用现有阶段和宏草稿：选中 0 处理一次，其余实际候选按提供商序号逐个处理一次；没有为其他候选另造只读宏权限。候选输出效果与最后消息写入同一事务；后续候选处理或最终 SQLite 写入失败时，零提交本轮 output 宏，保存原提供商 partial。生成期间扩展写入的最新 extra.variables 和未知键保留，旧 swipe_info 中的变量不能覆盖它们。此处没有复制 ST JSON/stream cleanup 次数不一致的行为，完整 power_user cleanup 等同另有范围。

`/api/backends/chat-completions/generate` 已随扩展兼容层移除；原生候选路径的字节保真与边界行为由本地服务内部测试覆盖。

有效旧运行时 before 见 `.cache/reports/native-n-before-dist-http-20261003-r2.json`：真实宿主/提供商 HTTP、GET 和 SQLite 都复现 JSON B、SSE B1A2、无 swipes；public 返回原始数据，189 个 runtime dist JS 与旧 candidate3 ASAR 逐文件一致。源码有效 before 为 `p01-native-candidates-before-20261003-r2.log`，初始 8 项全部失败。最终 `p01-native-candidates-after-20261003-r7.log` 12 文件 166 项全通过，其中原生候选 26 项；覆盖真实 native preflight/SSE、JSON、SQLite/backup/restart、两候选 reasoning/media/tools、停止/EOF/坏 JSON/重复序号、两种宏引擎、最新 extra 合并、受控落库失败回滚和删除全部候选 info 的边界。JSON 失败保留用量的独立 before 为 `p01-native-candidates-json-failure-usage-before-20261003-r1.log`，先复现 usage 丢失再修复；shared/service direct noEmit 日志 r4 均通过。r4 的公开 Claude 请求单次 502 在隔离及完整 r5/r6/r7 回归通过；r5 唯一失败是新增 ESM 测试的 new Function 动态 import 缺少 Vitest VM callback，改为正常动态 import 后完整 r6/r7 通过，保留所有中间失败证据。

本批没有将 Claude content-block index、Gemini candidateCount 或其他协议扩成多候选，也不以本轮证明 continue/quiet/impersonate 的候选 UI、完整 P01、付费模型表现或最终新 EXE。shared 独立构建只用于源码模块接线，service/renderer/desktop dist 和最终候选由统一发布流程另行构建与验收。

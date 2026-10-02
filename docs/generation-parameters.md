# 生成参数与最终请求预算

2026-10-02：扩展公开 `/scripts/openai.js` 的
`createGenerationParameters(settings, model, type, messages, options)`。
它返回 `{generate_data, stream, canMultiSwipe}`，与原生预处理、
`sendOpenAIRequest` 共用项目现有的请求构造器。

## 本轮实现

- 尊重显式模型、当前请求的上下文和回复上限；过滤空值/非对象消息，
  深拷贝消息与 JSON schema，避免模型特例改写调用者的数据。
- quiet 不启用流式和多候选；continue/impersonate 不启用多候选。
  接入现有停止字符串、custom YAML 宏替换、seed、logprobs 设置，
  以及已检查的 o1/o3/o4 参数调整。power_user 使用已有公开模块实例。
  OpenAI 请求不发送不支持的 top_k；custom 地址仅在显式启用时携带该字段。
- `_mycompanion_context_limit` 随请求快照传到本地 transport；它不会作为
  普通请求字段转发给模型，也不修改持久化设置。不同并发请求互不覆盖上限。
- 原生请求和扩展直接 fetch 共用 `chat-completion-budget.ts`，在扩展事件和
  custom body 编辑后检查实际消息、回复预留、tools 和 response_format。
  保留 512 Token 余量；非法/超额请求在调用模型前拒绝。
- 原始响应仍按字节转发，保留 SSE、多个 choice、工具和推理字段。

## 发现并修复的持久化问题

原版助手的预设作用域验收发现，助手重新启用后预设列表为空。
根因在通用设置补丁接口：无变化的 merge 返回 current 本身，后续删除
客户端的预设保留字段时也删掉了用于恢复该字段的 current。
现在先复制合并结果，再恢复服务端拥有的预设字段。
空补丁数组和 base/next 相同的补丁都纳入回归；修复前两者均会删除预设库。
这不是新增权限限制，也没有修改助手实现。

## 参考与复用

重新阅读固定 SillyTavern 1.19.0 的 public/scripts/openai.js
（7e8663cd9c184a550b37238218bdd32c6efc68e9）和此前评估的 Agnai
srv/adapter/chat-completion.ts。前者提供公开参数契约，后者的重复注入警示
支持共用组装/transport 的设计。沿用既有 AGPL、维护与适配评估；本次没有
增加依赖或嵌入完整酒馆，也没有声称重新验证上游最新维护状态。
PolyForm Noncommercial 的原版助手仅用于隔离验收，不进入分发源码或 EXE。

## 验证范围与剩余工作

服务用例验证请求级预算、并发隔离、schema/tools/custom YAML 改写后的超额
拒绝、失败后恢复、预设库无变化保存。完整 Electron 夹具验证公开模块入口、
输入不变性、显式模型、quiet/多候选和直接 fetch 的请求级预算。
原版助手验收额外记录本地 transport 收到的上下文上限，并拒绝 API fallback。

发送协议仍只覆盖 OpenAI/custom。完整的模型/提供商特殊参数、ToolManager
自动工具注册、PromptManager、多模态组装仍未全部实现。上面的字段支持
不代表其他提供商的原生协议已能发送。

直接世界书查询和扩展提示词组装现已在各自成功调用时提交宏效果，详见
macro-api-lifecycle.md；不同路径的有状态字段求值顺序仍待统一。原生字段中的
任意浏览器回调、剩余内建宏及默认引擎迁移也未完成。不得将本轮接口和预算
验证当作全目标完成或直接替换正式版的依据。

## 实际 EXE 证据

内部候选 `3b0238bbc63f83bc5778938a1952383e43ca0bbbf0d3389c806363d9f7d85b6c`
通过新人/错误恢复/宏专项（24 阶段）、原版助手两种生成与查看器、脚本作用域/更新/
重启，以及本地 smart-HTTP 仓库的实际 UI URL 安装更新。全部使用独立临时资料目录。
对应源码 315 文件，SHA256 为
`463447f399dad709a670f3e9dfcb6235ada1a82c3732f88e976789d9703cc0f0`。
源码与可执行文件的校验关系、报告位置及剩余范围见
`.cache/reports/generation-parameters-build-manifest-20261002.json`。
原版助手仍使用其默认 legacy 宏模式；宏引擎的独立产品夹具不能替代助手所有新引擎功能验收。
本段与根文档的验收结果为构建后补充，产品代码和验收脚本仍匹配冻结归档。

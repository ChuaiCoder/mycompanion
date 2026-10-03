# 桌面对话续写与代写

2026-10-03。此页记录源码 Electron 阶段，不代表最终单一 EXE 已验收。

固定 SillyTavern `7e8663cd9c184a550b37238218bdd32c6efc68e9` 的 `Generate`、StreamingProcessor、saveReply 和 openai.js 续写提示阶段为 AGPL-3.0-only。现有 PromptManager 与工具模块继续直接复用；桌面 UI、SSE 路由、SQLite 持久化及取消适配使用项目现有运行时。交叉阅读 RisuAI `f9728b14c733d073168d8d0c6a8f34f8febf0304` 的 GPL-3.0 process 实现：它同样保留原消息前缀并写回原位置，但聊天模型的固定 `[Continue the last response]` 指令不等同酒馆可配置 nudge/prefill 阶段，本项目按固定酒馆契约实现。GitHub 原始文件已读取，API 限流不能提供新的维护日期证据；未复制完整应用。

`续写回复` 延长最后一条角色消息，保留 ID、分支、已有前缀、未知扩展字段和当前候选，并将最终内容同步到当前 swipe。请求预检通过前不修改原消息。预览/取消预检不会创建占位消息或分支。流式停止保存原前缀与已接收片段；改变来源会让相关旧记忆失去可达性。续写保留输入框中的用户草稿。

PromptManager 按上游处理 continue nudge、prefill 与 postfix。非 prefill 的真实末尾消息移到 posthistory 后，再插入独立展开的 nudge；预算保留此控制块。prefill 沿用原版最后消息及控制提示规则。继续用户消息、群组强制角色与自动续写仍在后续范围，当前按钮只对最后一条角色回复启用。

`代写我的消息` 使用 impersonate 生成类型和用户输入正则，仅把文本放到真实输入框。它不添加用户/助手消息、不触发消息来源记忆提取；接受的显式宏变量与世界书 timer effects 按同一预检边界提交。`IMPERSONATE_READY` 在输入框提交后等待监听者，插件可以读取和修改真实输入。`Generate('continue')` / `Generate('impersonate')` 与按钮共用生命周期、停止和导航保护。酒馆工具模块按生成类型排除 continue/impersonate 的自动工具执行。

输入草稿存入现有本机 profile 的 `__mycompanion_editor_drafts.composers`，按故事独立保存。完全关闭/换服务端口后打开故事仍可恢复；输入框恢复异步执行时，新输入与新的导航优先，迟到恢复不会盖掉它们。发送清空该故事草稿；桌面关闭守卫等待现有 settings 队列写入完成。

## 证据

`foreground-modes.test.ts` 七项通过：同消息续写、代写无聊天行、两模式预览及预检取消、部分续写停止。renderer hook 十九项通过，包含续写同消息、代写仅草稿和迟到导航保护。

`verify-renderer-foreground-tools.mjs` 实际 React、原版 ToolManager ESM、磁盘 SQLite 和 loopback HTTP 十阶段通过。新报告为 `.cache/reports/renderer-foreground-tools-p01-actual-20261003-r4.json`，SHA-256 `51e984d1b8c5295caaba58ddc08422513786e48a3cbd2f6f1023a0d843f7f73b`。它覆盖续写/Generate preview/候选未知数据、代写/ready 事件、部分停止；异步工具资格、两个 ordinal、真实 DOM 副作用、工具错误结果与下一模型请求；停止和导航释放等待并阻止后继动作；五轮上限和 stealth；真实关闭/新端口恢复草稿、消息和工具轮次，下一请求只重放一次历史工具 transcript。

r1 是 runner 包导入前的语法错误；r2 暴露原输入草稿只依赖 sessionStorage；r3 的持久化已成功，但 runner 在异步恢复前立即断言输入值。失败报告保留。r4 等待真实恢复完成，未降低产品断言。协议窗口使用 OpenAI-compatible wire，Claude/Gemini 真 HTTP、完整源码与最终 EXE 证据另列，不由此推定全部 P01 已过。

工具正文只显示最终一轮回复；中间前言、推理、调用参数与结果保存在 `toolRounds`，可在真实消息中展开查看。每轮使用该轮提供商 usage 与 token accounting，不将不同口径相加伪造总量。原生 `responseState.media` 提供图片显示、音频控制和保存；连续同 MIME 的 raw PCM/L16/MPEG 分片按顺序合并，raw PCM 按明确声明的采样率和声道数封装 WAV，独立 WAV/图片保持分开。Blob URL 随组件生命周期释放；缺参数或损坏的内容给出失败状态。

新增真实窗口报告 `.cache/reports/renderer-foreground-tools-p01-media-rounds-20261003-r4.json`，checkedAt `2026-10-02T20:49:21.757Z`，SHA-256 `adf43d64145f5c4b0bc486f325e9fa161c54d8a9d2a45c197f508185a715045e`，十二阶段通过。保留原十阶段，新增实际展开工具前言/参数/结果及每轮 usage/accounting，原生非流式模型返回 PNG/WAV 后由真实 `<img>` 解码、`<audio>` 静音播放与暂停、显示下载链接，完全关闭/新端口打开后再次解码。PCM/L16 顺序与格式边界有两项专项测试；此窗口不代替全部流式音频格式的真实提供商验收。

媒体 r1/r3 使用的 PNG 测试样本有损坏的 IDAT CRC 和 zlib checksum，隐藏窗口的 lazy 图片还会延迟加载；媒体 r2 是旧 service dist 导入已移除 image-size 依赖失败。对应失败报告保留。媒体 r4 改为合法 PNG、实际媒体阶段显示窗口并滚动到消息，给 decode 等待设置上限；实际图片尺寸、音频播放时间及重启恢复断言未降低。以上仍是源码 Electron，最终单一 EXE 验收另记。

媒体/向量/输入草稿及同期 U05 源码落稳后，renderer 全套二十三文件、一百一十五项通过，报告 `.cache/reports/renderer-media-vectors-full-20261003-r1.log`，SHA-256 `5d37e90c3499eab1e8e330fd5efcda3bddbc5c175f3a5f16c0abe213434c4ff7`；renderer typecheck 和 build 通过。此检查包含现有 hook/UI 回归，不代替完整源码组合或最终 EXE。

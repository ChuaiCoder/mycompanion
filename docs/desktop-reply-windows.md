# 桌面候选回复与长故事消息窗口

2026-10-03。源码 Electron 验证，正式 EXE 尚未更新。

同一消息的导入/plugin swipes 直接使用真实 getContext().chat、swipe_id、swipe_info 和 extra。切换前 flush 旧写入，核对故事、分支和消息 ID；保存旧候选文本/时间/extra，恢复所选候选，更新同一个真实消息 DOM。MESSAGE_SWIPED 是 awaited 事件，监听器可以修改消息或导航。debounced snapshot 在事件前捕获，导航时交给原队列保存旧目标；事件返回后不能对新故事调用旧目标的 save。实际写入失败使用显式 durable reconcile，默认 reload 仍保留 failed queue 错误，不吞掉其他新草稿或失败。

原生重新生成保留独立回复分支，复用现有 activateBranch 和记忆 reachability，不将整段分支压成同一消息的 swipes。用户展开“回复分支”后才读取全部分支导出；候选要求相同用户 anchor、相同前缀和相同消息长度，已继续或编辑前缀的分支不冒充同轮回复。前缀用既有 toExtensionMessage 归一化原生/持久化默认字段，未知字段仍参与比较。切换等待旧 host flush，并用共享 navigationRevision 拒绝导航后的迟到返回。

对照固定 SillyTavern `7e8663cd9c184a550b37238218bdd32c6efc68e9` 的 syncMesToSwipe、syncSwipeToMes、swipe 和 printMessages（AGPL-3.0-only），采用其真实 message/event 合约和分批显示设计。新窗口逻辑为本项目实现，没有复制完整酒馆。BYAF MIT 输出候选规格、RisuAI GPL-3.0 仅为比较，研究来源见 `.cache/reports/u04-swipe-research-20261003-r1.json` 与世界书编辑说明。

MessageSurface 默认只建立最近 100 条 React portals，完整 conversation 和 host chat API 保留全部消息，mesid 使用完整 chat 的 absolute index。用户点击实际 show_more_messages 按钮加载前 100 条，完成 DOM 提交后发 MORE_MESSAGES_LOADED。插件 print 重置默认窗口；显式 add/swipe 可显示较早消息；插件直接移除或修改的外层 DOM 保留原语义。记忆来源主动展开包含来源的较早页并聚焦真实节点。用户主动打开很早的来源可能展开多页；本次性能门槛测量的是默认 100 条窗口。原来的逐消息 find 被完整索引和显示窗口 map 替代，默认同步不再对全部 chat 建 DOM 或进行 O(n²) 查询。

## 证据

真实 runner `apps/desktop/scripts/verify-renderer-reply-windows.mjs` 报告 `.cache/reports/renderer-reply-windows-swipe-g06-20261003-r8.json`，checkedAt `2026-10-02T19:51:36.816Z`，SHA-256 `9705e75f73997c2a5264cbcdceb08fb144995afc9d02fd90da31fcdf256e17c0`。九阶段通过：真实 JSON 卡导入/HTTP 生成；实际重新生成/选择旧原生分支及来源可达性；真正 awaited swipe listener 在保存前修改数据；真实 SQL INSERT trigger 失败回退 host/DOM 和重试；监听器真实故事导航保住旧目标而不污染新故事；10,000 消息完整 host/100 条默认 DOM 和缓存首屏采样；插件加载页/事件/print/add/swipe/完整持久化；实际记忆来源跨默认窗口跳转及焦点；实际关闭/新服务端口后从故事列表重新打开候选/分支与全部 10,000 消息。

缓存实际 app reload/resume 以 5 次预热、30 次采样测量；从 reload 起直到完整 host 10,000 条、100 个真实消息 portals、输入可用。最近秩百分位 p50 1517.26 ms、p95 1870.93 ms、最大 1897.60 ms，p95 <2000 ms。硬件 Intel i5-14400F、16 logical CPUs、34,072,662,016 bytes 内存、Windows 10.0.26200、Electron 44.4.4/Chromium 152.0.7977.130、软件渲染。报告保留每次采样原值；不将这个确定性文本 fixture 推广为其他硬件、大量媒体或扩展任意代码的性能保证。

r1 是 harness 顶层 await app.whenReady 的 Electron ESM ready 死锁；r2/r3 把 replace-all chat 保存误当 UPDATE，实际故障注入应使用 INSERT trigger。r4 找到真实产品缺陷：乐观 swipe 已改 row，而上一 durable signature 未变，reload 忽略正确 durable 内容；现比较当前 row 的真实内容，回退保持同一个 DOM。r5 是 harness 未等库页提交；r6 误要求跨新端口 sessionStorage 自动恢复，改为实际故事列表打开，符合既有恢复入口。r7 找到第二个真实产品缺陷：原生分支前缀与 extension 保存后默认字段差异导致候选消失；现归一化默认字段并比较其余真实前缀。所有失败报告保留，r8 重新执行全部阶段。

有针对性的 renderer 回归另覆盖 10,000 默认窗口、插件删除与旧节点、optimistic/durable 同节点恢复、awaited listener 修改/导航、reload 失败、分支前缀及导航过程中 activation 的迟到返回。它们与实际桌面报告分别保存；同一最终 EXE、完整上游 swipe 动画/开场白宏/新生成循环、G06 完整故障和安全仍需各自验收。

## Native多候选的显示状态（源码阶段）

2026-10-03后续源码使用共享 `projectNativeCandidateMessage`，在实际 awaited `MESSAGE_SWIPED` 之前换入所选候选的状态、reasoning/media、finishReason与completionOutcome；旧候选private provenance保存在其自身swipe_info.extra，variables与未知键保持原同步/三方合并语义。request的usage、预算与真实toolRounds审计只保留一份；所选候选不借用另一候选的响应状态。没有有效private info的外部候选与手改正文不继承旧响应签名，原candidate0工具历史能否进入下次请求由共享helper单独判断。

新增两项真实before失败证明旧renderer会保留candidate0状态/媒体。after的swipe、branch与chat-stream共3文件10项通过，renderer类型检查通过；日志 `renderer-native-candidate-before-20261003-r1.log`、`renderer-native-candidate-after-20261003-r1.log`、`renderer-native-candidate-typecheck-20261003-r1.log` 分开保存。这些是组件/运行适配器源码证据，尚未属于候选3或新EXE。候选按钮与回复分支应用标签跟随中英文，数量使用locale，正文和扩展错误原文保留。

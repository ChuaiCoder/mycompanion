# 角色世界书与高级编辑

2026-10-03。本项为 U04 源码与真实源码 Electron 证据，不代表正式发行 EXE 已更新。

世界书使用已有编辑面板、角色表单与 Popup。对照固定 SillyTavern `7e8663cd9c184a550b37238218bdd32c6efc68e9` 的世界书字段及生成阶段（AGPL-3.0-only），复用项目既有世界书运行时、SQLite repository、草稿和宿主事件接口。RisuAI GPL-3.0 的分阶段 lore 匹配及 BYAF MIT 场景/输出结构仅作交叉比较，未嵌入完整应用。来源与适配记录为 `.cache/reports/u04-swipe-research-20261003-r1.json`，SHA-256 `0b26c7f30b8d4453548f51717f2948efaa93712b06b61aa52734cbaa4c83501e`；它是设计调查，不是功能验收。

角色带有有效 named 主世界书时直接打开它，不重复复制或写角色。只有嵌入书时先从真实 Popup 输入书名，再在同一 SQLite savepoint 中复制并绑定。复制保留原始 character_book、originalData 和未知字段；新书使用角色实际生效的 enabled 状态。缺失或重复条目 ID 仅在副本中分配唯一 ID，原卡不改。名称冲突、过期角色 revision、缺失来源和真实 SQL 失败均不给出半本书或半绑定。绑定书存在时命中来源只用该 named book；删除 named 后可回退到嵌入书。界面使用真实角色重新读取，以免旧卡快照盖掉刚切换的 enabled 状态。

高级匹配控件包括辅助词及四种条件、顺序、八种插入位置和 Outlet 名称、深度及消息身份、可继承扫描深度/大小写/整词设置、概率、预算、递归限制、互斥组及优先/权重/评分、sticky/cooldown/delay、六种生成 triggers、角色文件名 include/exclude、六种角色/人设字段扫描开关。全局面板包含 min activations、depth max 和 group scoring。角色表单另有 depth prompt/深度/身份、示例、system prompt、post-history instructions、作者资料和备用开场白。草稿按书和角色分别保存，取消、关闭、重启与异步导航不会互相覆盖。

## 实际验收

服务专项六项通过，包含真实 INSERT/角色 UPDATE trigger 失败后的整体回滚、重试幂等、effective 开关、未知字段/原卡不变、重复 ID、实际 prompt 一次注入。WorldInfoPanel 与 ChatView 专项十项通过，含取消/失败保草稿、角色导航及旧书迟到读取失败不覆盖新书。它们不替代当前完整源码检查。

真实 runner `apps/desktop/scripts/verify-renderer-world-advanced.mjs` 报告 `.cache/reports/renderer-world-advanced-u04-real-20261003-r6.json`，checkedAt `2026-10-02T19:12:38.129Z`，SHA-256 `21e02af8f2f663251f8396e2e8f197166c285742bee0b3f49166fd3c417ed225`。十一阶段通过，实际 React、磁盘 SQLite 和原生 HTTP 模型请求验证：JSON 卡导入/嵌入开关；Popup 取消无写入/独立草稿；真实 SQL 失败回滚；重试绑定和只注入一次；高级字段未提交关闭/新端口恢复/保存；真实 normal 请求消费辅助 AND_ALL、depth 0 user、组 override、角色 exclude、triggers 和 Outlet；quiet 过滤且不增故事消息；UI 修改评分/权重改变候选；全局最低激活与深度控制旧消息召回；连续生成验证 sticky、cooldown、delay；完整关闭/新端口重启恢复绑定、字段、设置、timers 和两份草稿。

Outlet 顺序遵守固定上游：script.js 在 4461 左右先展开角色字段，4635 扫描世界书，4674 写 Outlet，5287 再把已经展开的字段交给 PromptManager。因此 description 中本轮 fresh Outlet 保持扫描前的值，不为它重复执行全卡宏。报告同时验证 description 为 `ROLE `、扫描后 extension prompt 为 `OUTLET_POST OUTLET_SIGNAL`。这两种结果都符合实际调用阶段。

追加的 automationId 真实窗口报告为 `.cache/reports/renderer-world-advanced-u04-automation-20261003-r1.json`，SHA-256 `e395ed7a76e62d99dfe999f87a23f404dad224afcd000519ded7f01bb6822f64`。十四阶段通过，覆盖原十一阶段及三个新增阶段：实际高级字段设置 automationId，原版 Quick Reply AutoHandler 执行同 ID 的 `/incvar` 和 `/incglobalvar`；normal 与 quiet 各执行一次，模型实际请求在 postscan prompt 消费 `QR_AFTER 1/1` 和 `QR_AFTER 2/2`；真实预览不执行自动化，完全关闭/新端口打开后保留 automationId 与已提交的本地/全局变量和另一世界书草稿。

随后补充原生向量入口：条目的 `vectorized` 开关和全局 `enabled_world_info`、`enabled_for_all`、`query`、`max_entries`、`score_threshold` 五设置。它们读写同一 `extension_settings.vectors` 并保留未知属性，Embedding 任务使用已保存的独立模型连接。保存失败保留未保存值和失败提示，沿用现有 settings 队列重试，不显示虚假的回滚状态。

真实报告 `.cache/reports/renderer-world-advanced-u04-vectors-20261003-r1.json`，checkedAt `2026-10-02T20:49:02.353Z`，SHA-256 `9805c569125865324e15c393ff10355d050d1c2eedbc2d55f3f38c7797f6805e`，十八阶段通过。在原十四阶段上追加实际 UI 保存五设置与条目开关，调用专用 Embedding profile 的真实 loopback HTTP，无关键词时只召回 vectorized 条目，启用所有条目后召回两条，关闭向量后聊天继续且无新增 Embedding 请求；完全关闭/新端口打开后恢复条目字段、五设置、未知属性、任务分配和另一书草稿。确定性测试返回相同 `[1,0]` 向量，只证明实际网络、原版选择算法和持久化，不证明语义模型召回质量，也不代替最终 EXE/U05 证据。

r1/r2 为 runner 内嵌动态脚本 newline 转义不足；r3 为发送等待错认旧回复；r4 为 runner 错误要求角色字段读取本轮 fresh Outlet；r5 为 quiet 请求误假设 stream true。所有失败报告保留，r6 修正 harness 的实际阶段判断，没有降低产品断言。

## U04 完成边界

U04 要求已经支持的字段可展开编辑，保存/重启一致并影响真实请求。冻结 r6 对应 native named-world 字段和角色高级项已提供入口，真实十一阶段及此前角色深度阶段分别验证请求和重启。`characterFilter.tags` 只保留未知值，native 尚无 characterTagIds 产品管理流程；冻结阶段 vectorized/addMemo/automationId 等没有完整原生消费者的字段未作为已支持字段展示。它们的实现是 W01/扩展兼容范围，不能通过增加空控件算完成。随后 W01 新增原版 Quick Reply automation 与向量匹配消费，automationId/vectorized 已补真实编辑控件，追加真实窗口请求和重启验收另存新报告，不沿用 r6 作为新增消费者的证据。addMemo 的完整 native 消费仍不由本报告推定。

U04 的源码功能可按其独立完成标准登记；报告初写的 completeU04:false 是冻结时保守状态，不能因为其他 G02/G04/G05 未过而将已验证编辑器重新记为未实现。同一最终 EXE 的完整回归仍需 G01/G02，英文、键盘/读屏及 WCAG 2.2 AA 仍需 U05，不能从本报告推定通过。

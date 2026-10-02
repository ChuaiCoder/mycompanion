# 角色字段与世界书宏求值阶段 — 2026-10-02

本次统一原生生成的首次角色字段读取与世界书扫描顺序，并区分浏览器 legacy 的完整字段读取
和新引擎的惰性读取。这是明确阶段的兼容修复，不代表完整 SillyTavern 生成流程已经等价。
公开 API 的变量提交、CAS、迟到响应和 dryRun 契约沿用
[macro-api-lifecycle.md](macro-api-lifecycle.md)。

## 核查依据与复用

重新读取固定 SillyTavern 1.19.0 commit
`7e8663cd9c184a550b37238218bdd32c6efc68e9` 的 `public/script.js`、
`world-info.js`、`openai.js`、`PromptManager.js`、`power-user.js` 和宏环境构建器。
首次字段顺序来自 `getCharacterCardFields` 的实际读取顺序，不能用 lazy 对象的属性定义顺序代替。
世界书 `WorldInfoBuffer` 直接拼接调用者提供的全局扫描字段；`PromptManager.preparePrompt`
会再次调用 `substituteParams`，不能由首次字段读取推断整轮求值次数。

原版助手的 `prepareAndOverrideData` 也会先读取角色字段再扫描世界书，并存在独立的 depth、
creator notes 等求值调用。本次保留这些公开调用的效果，不通过原文相同或全局缓存将它们消除。
继续采用既有 Agnai adapter 比较结论：复用当前组装器，不另建模型生成通道。许可、维护状态
和适配评估见 [macro-engine-reuse.md](macro-engine-reuse.md)；本次不声称检查了更新的上游版本。

`packages/shared/src/character-macro-fields.ts` 提供项目实现的统一字段读取规则，由浏览器和服务端共用。
`packages/macro-engine` 已合法复用固定酒馆的解析器、环境构建器、utility/control-flow 和
CHARACTER 宏定义；原路径、原始哈希与改造说明记录于 `packages/macro-engine/upstream.json`。
CHARACTER 定义保留惰性访问、别名和 greeting 索引类型规则，示例解析及 instruct 格式化通过
当前调用的 host 函数提供，缺少必需函数时保留宏并报告错误。

这些复用源码属于 AGPL-3.0-only，项目保持同一许可，并随对应源码提供修改内容及许可文本。
Chevrotain 等依赖保持既有 Apache-2.0 通知，见根 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
原版助手属于 PolyForm Noncommercial，只用于隔离分析与验收；其代码、研究副本或构建产物
不复制进产品、对应源码归档或 EXE。桌面产品继续采用独立实现。

## 原生首次字段读取 → 世界书 → 组装

原生 normal、quiet 和 prompt-preview 在世界书前创建一次完整字段快照，顺序为：

`system → mesExamples → description → personality → persona → scenario → jailbreak → version → charDepthPrompt → creatorNotes → firstMessage → alternateGreetings`

`version` 保留原值，不执行宏。即使某个字段没有直接进入模型消息，首次完整读取仍执行其宏。
每个 alternate greeting 单独求值；两条原文完全相同的备用开场白仍产生两次变量效果。
惰性 getter 只在当前字段对象内缓存；原生会话只复用这一次明确的首次读取阶段，不能将独立
公开调用、不同字段或相同文本的多个出现位置合并成一次调用。

聊天 metadata 的 system、scenario、examples 覆盖在读取前应用；
`prefer_character_prompt:false` 和 `prefer_character_jailbreak:false` 阻止对应字段的求值与注入。
字段先 trim，再执行基础宏替换；`collapse_newlines:true` 按酒馆 `collapseNewlines` 将连续
LF 合并为一个 LF，随后删除 CR。此顺序不能换成先删除 CR 再合并换行。

世界书扫描直接使用已求值的 description、personality、persona、scenario、depth 和 creator notes。
扫描器不再次解析这些文本，因此残留的宏字符不会因为世界书读取字段而执行。
关键词仍在每次实际匹配时求值，并保留递归和短路顺序；选中内容仍在相应内容阶段求值。
预算按组装后的消息计数，不为计数重新执行字段宏。

首次人设读取与后续组装人设有明确的区别：OpenAI 的 IN_PROMPT 人设会在后续阶段再次读取
原始人设文本。当前原生组装使用独立的 `assembly:persona` 阶段。例如原始人设只有
`{{incvar::personaRuns}}`，首次快照读取后为 1，组装读取后为 2；这不是数据库提交两次。
原生 skipWIAN 仍读取完整角色字段，只跳过世界书和 Author's Note 阶段。人设是否再次用于组装
取决于位置与该阶段是否有效，不能因未注入人设而删掉首次字段读取的效果。

prompt-preview 和原生 dryRun 仅修改本次草稿，不持久化宏变量。接受的 normal/quiet 请求在
既有校验通过后一次提交该草稿的最终差异。首次字段副作用、世界书副作用和明确的组装副作用
属于同一个草稿，不等于把所有宏强制执行一次。

## 公开 API 与浏览器字段环境

公开 `getWorldInfoPrompt` 的 `globalScanData` 是调用者已经准备的扫描文本，按字面拼接。
例如 `characterDescription="{{incvar::scanEffects}}"` 不应被变成 `1`，也不应因此执行
`scanEffects` 的递增。这与原生先读取角色卡再生成扫描文本是两个入口契约。
未提供的扫描字段保持为空，不隐式读取角色卡原文。两种引擎的省略字段回归在修复前失败，
记录于 `character-macro-phases-scan-default-before-20261002.log`。

公开 `prepareOpenAIMessages` / extension-prompt-assembly 也独立于原生首次字段阶段。
调用者可能已经通过 `getCharacterCardFields` 获取字段，或显式提供本次字段覆盖；公共组装不会
再次插入一次原生完整角色读取，也不会借机求值未使用的已存 creator notes、开场白等字段。
组装自身的已实现宏调用仍保留，成功 API 的效果按既有公开生命周期提交；之后模型传输失败
不会撤回或重复这些效果。共享组装器不意味着两个入口拥有相同的前置求值阶段。

浏览器 `substituteParams` 保留两种引擎的实际字段环境：

- legacy 对非空文本在默认 `replaceCharacterCard:true` 时，先完整读取角色字段，再替换当前文本。
  即使当前文本没有引用角色字段，也会发生这次读取。`baseChatReplace` 使用
  `replaceCharacterCard:false`，避免读取字段时重新进入完整角色读取。
- 新引擎建立 lazy 字段环境，仅在宏实际访问字段时求值；同一个环境的同一字段只首次读取时
  求值。再次调用 `getCharacterCardFieldsLazy` 或 `substituteParams` 会创建独立环境，不能跨调用
  复用旧字段结果。

## 本次单元验收证据

`apps/local-service/src/character-macro-phases.test.ts` 的原始四项回归在修复前全部失败，完整
输出保存在 `.cache/reports/character-macro-phases-before-20261002.log`。它们观察到原生
description 先于 system 求值、世界书先于完整卡片读取，以及公开 scanData 的宏被重复解析
并写入数据库；原记录保留，不覆盖为通过结果。

增加 trace 后四项通过，记录于 `.cache/reports/character-macro-phases-after-20261002.log`。
随后追加 metadata、偏好、换行和重复备用开场白回归，两种引擎共六项通过，记录于
`.cache/reports/character-macro-phases-after-r2-20261002.log`。测试检查真实提供商请求消息、
完整字段轨迹、世界书读取值、数据库变量，以及预览无写入和 quiet 不新增聊天消息。

首次完整检查的四项失败揭示了公共组装被错误增加原生完整字段读取的问题，记录于
`.cache/reports/character-macro-phases-check-20261002.log`。现在通过内部
`prepareNativeCharacterFields:false` 保持公共入口边界，保留原有 16 条 API 回归断言；
`extension-prompt-overrides.test.ts` 增加两种引擎 × 是否显式传入世界书的四项覆盖测试，确认
显式 system/PHI 覆盖不受角色偏好阻断、不读取无关卡片字段，并对实际消息进行 Token 计数。

`.cache/reports/character-macro-phases-check-r3-20261002.log` 记录上述默认扫描修复后的完整类型检查、
407 项测试（shared 10 + character-card 14 + service 344 + renderer 39）和构建通过。
这些结果是本次明确阶段协议的证据，不是完整酒馆调用次数的证明。
冻结 EXE 的验收单独记录；之前候选的验收结果不能用来证明本轮改动。

## 桌面集成检查

`character-macro-phases-helper-viewer-20261002.json` 中未经修改的助手完成初始化，
legacy/new 两种引擎各执行流式、非流式生成，宏计数、落盘与 normal/quiet 查看器通过。
源码运行仍记录两条外部 Failed to fetch，不作为无资源错误的发布证明。

首轮新 Electron 验收卡因缺少 CCV2 必填 tags/creator 而被导入接口正确拒绝为 422；
补齐合法卡后，两模式实际导入均为 201，失败与独立导入检查报告保留。
下一轮执行到公开 API 生命周期时发现旧断言漏掉了 legacy 扩展快照中的完整读卡：
每条已选普通提示词也会读取人设，随后组装再次求值原始人设。
现在记录真实请求中快照条目及调用前后状态，按选中条目数推导副作用；没有清空人设、
屏蔽调用或接受实际值作为预期。CAS、重入、故事切换与模型消息断言全部保留。
两次失败分别见 `character-macro-phases-electron-before-20261002.json` 和
`character-macro-phases-electron-r2-failure-20261002.json`。

完整 `character-macro-phases-electron-r3-20261002.json` 通过，新增阶段在真实 ESM 文档
中检查 legacy 普通文本读取 11 个字段、新引擎读取 0 个字段、各次快照隔离、名称与换行；
原生 preview/normal/quiet 通过真实 HTTP 发送，世界书读取完整首次快照，模型消息与预览一致。
既有变量冲突、重入回调、迟到响应与真实故事切换检查也通过，保留合法的独立调用副作用。

## 同一冻结便携 EXE 验收

本轮验收使用内部候选
`.cache/packaging/character-macro-phases-candidate-r2-20261002/MyCompanion-0.2.1-windows-x64.exe`，
大小 176,062,297 字节，SHA256：
`3a423ab22935bb384331b8ac108bbd3959fb7c76b458828fc8b6e14b09c81dcc`。
包内对应源码归档含 328 个文件，SHA256：
`893ae8cb1b1c32a9644ab3c7a9f1bc26d36dd6ffab0e54c880060cda3426e57c`。
以下四组报告均记录相同 EXE 路径与哈希，顺序运行，合计 41 个阶段通过：

| 报告（`.cache/reports/`） | 阶段 | 主要验收范围 |
| --- | ---: | --- |
| `packaged-character-macro-phases-onboarding-20261002-verification.json` | 24 | 新人错误恢复、角色文件导入、真实发送、两引擎角色字段/原生 HTTP 阶段、变量冲突与迟到响应、完整重启 |
| `packaged-character-macro-phases-viewer-20261002-verification.json` | 6 | 未改动助手初始化、公开参数 API、两引擎流式/非流式宏、normal/quiet 查看器及完整重启；14 次模型请求 |
| `packaged-character-macro-phases-scopes-20261002-verification.json` | 8 | 脚本生成、启停和更新、角色/预设作用域、变量保存、快速切换与延迟保存、完整重启；7 次模型请求 |
| `packaged-character-macro-phases-url-20261002-verification.json` | 3 | 无系统 Git 的 UI URL 安装、启用后 JS 执行、相同 URL 更新并保留启用状态 |

viewer/scopes/url 的 `errors` 均为空。onboarding 的运行异常为 0，仍保留故意触发的
坏密钥 401、预算 400、变量竞争 409，以及两次 quiet 请求取消。它们是失败路径验收证据，
不能将报告写成所有请求无错误。六次 Electron/本地服务关闭耗时为 942–1,059 ms，
含便携启动器的全部进程关闭为 945–1,062 ms；助手两组的四次进程退出码均为 0。

首个候选 SHA256 为 `bb07568ffb9b064814c4f39c3b75d7616ff8091e288a2a214c36ac43800e06e2`。
其验收适配器在无请求体的 DELETE 上错误发送 JSON Content-Type，Fastify 正确返回 400，
导致测试角色清理失败，不能记为通过。失败报告及日志保留为
`packaged-character-macro-phases-onboarding-before-20261002-verification.json` 和 `.log`。
修正 `verify-packaged.mjs` 为仅在 payload 非 undefined 时发送 JSON 请求头和请求体后，
重新冻结 r2 源码与 EXE；没有放宽接口或删减断言。r2 onboarding 日志为
`packaged-character-macro-phases-onboarding-r2-20261002.log`。

`character-macro-phases-build-manifest-20261002.json` 和
`character-macro-phases-source-review-20261002.md` 关联四组报告哈希、逐文件源码哈希与前轮
321 文件基线。产品代码和验收脚本匹配冻结归档，验收后补充的文档单列为差异。
包内检查确认无完整酒馆、独立 Node、助手代码或用户资料。
`release/` 仍仅有原正式 EXE，其 SHA256 保持
`722dce179165fcf8df3c9b1c0e47968941a1bf2dc5cfcd1fa926bd2bcb1d30a5`，`output/` 为空。
这些专项结果不表示剩余兼容工作或正式发布门槛已经全部完成。

## 仍待完成

完整 PromptManager 的后续重复替换、`original` 和用户自定义提示词顺序尚未全部接入。
原生服务的每次 legacy 求值还没有像浏览器酒馆环境那样无条件重新读取整张卡，当前首次阶段
修复不能替代该契约。扩展提示词用于扫描和用于后续组装时，上游可能独立求值多次；现有原生
缓存和调用顺序尚未证明覆盖所有此类效果，不能以字符串相同作为去重理由。

CHARACTER 定义的复用也不代表原生字段环境已经绑定完整。例如有描述的角色上下文中，浏览器
默认 `substituteParams("{{description}}")` 会读取该字段；当前原生基础求值没有相同的字段环境，
legacy 保留 `{{description}}`，新引擎在缺少字段值时可能得到空文本。本次首次快照不能解决
所有这种调用环境差异。

重复 pass 还能改变残留宏的效果。例如 `later` 的值为 `{{incvar::counter}}`，某个字段使用
`{{getvar::later}}`：首次读取可得到字面的 `{{incvar::counter}}`；酒馆后续
`PromptManager.preparePrompt` 再次求值时会执行这个递增。当前原生复用首次快照的字段内容，
没有实现所有这些后续 pass，因此不能把“复用快照不重复解析”扩展成整轮宏都只执行一次的保证。

浏览器注册的任意宏回调和 provider 仍未接入原生角色字段、关键词与世界书内容执行环境。
原版助手额外公开调用、新引擎按需读取与 legacy 完整读取的整轮组合，仍需逐路径验证。

公开组装还保留一个此前已有的世界书回退：同时省略 `worldInfoBefore` 和 `worldInfoAfter`
时会调用本地扫描；固定酒馆 `prepareOpenAIMessages` 只格式化传入的世界书，不自行扫描。
只读复现报告 `character-macro-phases-public-wi-gap-20261002.json` 包含两引擎 × 省略/显式空
四组完整请求、响应和变量记录：省略时常驻条目 `WI={{incvar::worldReads}}` 被注入并提交
`worldReads=1`，显式空时不注入、变量不变。上游 `openai.js:789`、`:1367`、`:1542`
的固定源码、哈希与逐行引用也保存在报告中。这是待修复的公开入口差异，不影响本轮已经
证明的“公共组装不增加原生首次完整读卡”边界，也不能以本轮 EXE 专项通过将其标记为兼容。

其他剩余内建宏、完整 ToolManager、多模态与提供商协议也不在此次阶段修复的完成范围内。
因此仍不宣称 full parity，也不据此迁移默认宏引擎或标记正式发布就绪。

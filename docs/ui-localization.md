# 界面本地化的当前范围

核查日期：2026-10-03。U05 尚未完成；语言切换不等于全界面翻译或 WCAG 2.2 AA 合格。

## 实现选择

| 项目 | 许可证与维护证据 | 对本项目的适配 |
| --- | --- | --- |
| i18next + react-i18next | 精确安装 26.4.2 / 17.0.15，均 MIT；npm 版本/许可证及安装包 LICENSE 已核对 | React hook 随语言变化重新渲染；内嵌字典离线可用，适合渐进迁移现有桌面 UI |
| react-intl | npm 当前 12.1.3，BSD-3-Clause | ICU 消息和日期格式成熟；引入同样可行，但没有必要与现有应用再维护第二套消息系统 |
| 缓存 LobeChat | 项目 MIT；其 package.json 已使用 i18next / react-i18next | 支持采用相同成熟库的工程选择；没有复制其界面、字典或实现代码 |

参考：[i18next](https://github.com/i18next/i18next)、[react-i18next](https://github.com/i18next/react-i18next)、[FormatJS](https://github.com/formatjs/formatjs)、[LobeChat](https://github.com/lobehub/lobe-chat)。直接复用的是 MIT 库；自编字典使用项目原许可证。Vite 输出的 THIRD_PARTY_LICENSES.md 收录发行依赖许可证。

## 已接通

- 设置页提供简体中文 / English 切换；导航、服务状态和模型连接的标题、说明、字段、按钮已有真实英文文本。
- 字典随程序内嵌，不请求外部翻译服务；用户角色、故事及导入的扩展文字保持原内容。
- 语言偏好存于共享设置（`extension_settings.__mycompanion_preferences.language`），使用既有设置写队列；服务端口变化不依赖浏览器 origin 存储。
- document.lang 随语言更新；来源及备份日期使用对应 locale。
- 模型错误提供文本与纠正按钮，点击后聚焦实际字段；记忆来源导航聚焦实际消息。现有 Ctrl/Cmd+I 导入快捷键保留。

## 角色库与导入界面子集

实现位于 `LibraryView.tsx` 与 `library-translations.ts`；侧边栏（`AppSidebar.tsx`）中角色卡 file input 的 accessible name 也调用同一字典，保留原 input、ref、文件类型、禁用条件和选择回调。共享 `Metric`、`ExpandableDescription`、`RichTextPreview` 和 `ImportedContentDetails` 只增加可选 locale/translate 参数。本轮字典是项目自编应用文案，没有复制第三方产品的字典或样式，也没有新增运行依赖。

| 入口 | 已接通的文案与格式 | 保留的行为 |
| --- | --- | --- |
| 新手三步与已载入角色 | 导入、连接模型、开始故事，说明及按钮 | 同一个文件选择、模型设置和开始聊天回调；不因切换语言触发操作 |
| 导入预览 | 助手说明、格式检查、警告、字段处理、未保存状态、确认与取消 | 角色名、简介、HTML 开场白、文件名、未知字段路径保留原文；仍先预览后确认保存 |
| 批量与重复卡 | 逐文件状态、失败重试、跳过/取消整批、内容/名称匹配、打开/复制/替换及重新检查 | 实际 File、重复角色 ID 与 expectedUpdatedAt 不变；语言切换不再请求预览、不提交导入 |
| 资产、随卡故事与导出 | 实际识别数量、附件/备份/外部地址说明、JSON/PNG/CHARX 标签和格式限制 | 保留原资产保存、备份与导出语义，没有新增下载、确认或权限步骤 |
| 附属内容预览 | 世界书/正则标题、状态、关键词/阶段等应用标签、长简介展开标签、HTML 源码的 accessible name | 世界书名称/正文/关键词、正则名称/表达式、用户标签和人物设定始终原样显示；既有 disclosure 展开状态保留 |
| 动态数量与反馈 | 数量采用 en-US / zh-CN 格式；已知导入错误和保存/打开成功提示跟随语言 | 仅识别既有应用模板；未知服务详情与其中的数字保持原文，动态角色名不被当作待翻译词条 |

针对性回归（`.cache/reports/renderer-library-localization-20261003-r3.log`，2 文件 / 11 tests 通过，日志 SHA-256 `b2814deb1cf62ff638dd4038120e972ff82ab30be00a208b1fa596a486653110`）：6 个角色库案例验证现有回调、新人三步、实际 `useCharacterImport` 与 HTTP API 路径；语言切换往返（中→英→中→英）不产生额外预览或提交请求；批量失败经原 hook 重试原文件；数值按英文显示 `1,000`。r1/r2 报告保留。这些测试没有打开 EXE、读取私卡或执行 OS 文件对话框；最终候选的实际英文操作、长文本/窄窗口、全部高级编辑和辅助技术操作仍需各自验收。

## 未完成

聊天操作、世界书/正则高级字段、记忆、备份、预设还有中文固定文本；后端错误/规则理由也尚未完整本地化。尚缺全部界面的键盘导航、读屏、长文本、缩放和 WCAG 2.2 AA 实际审计。当前工作仅完成 U05 的基础及首批页面，清单必须保持开放。

## 源码验证

首次真实桌面重启检查发现 locale 初始化覆盖 `document.lang` 的竞态；失败报告 `renderer-data-workflows-k02-u05-20261002-r1.json` 保留。修复后，`renderer-data-workflows-k02-u05-20261003-r2.json` 的 12 阶段通过，其中最后一阶段通过真实中文/英文界面选择、共享设置保存、关闭、新服务端口和新窗口恢复。SHA-256 为 `86d162e27bc0789356fb30c1176392e989415cdc074010eb6f7cb9bc6295244d`。这是源码 Electron 报告，尚未覆盖新的正式 EXE。

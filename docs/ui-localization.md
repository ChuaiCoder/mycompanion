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
- 字典随程序内嵌，不请求外部翻译服务；用户角色、故事及扩展文字保持原内容。
- 语言偏好存于同一 profile 的 extension_settings.__mycompanion_preferences.language，使用既有共享设置写队列；服务端口变化不依赖浏览器 origin 存储。
- document.lang 随语言更新；来源及备份日期使用对应 locale。
- 插件 locale 从共享 profile 偏好初始化，并订阅 `mycompanion:language-changed`，使用对应简体中文/英文目录。慢初始化不会覆盖用户刚选的语言。
- 模型错误提供文本与纠正按钮，点击后聚焦实际字段；记忆来源导航聚焦实际消息。现有 Ctrl/Cmd+I 导入快捷键保留。

## 未完成

角色导入说明、聊天操作、世界书/正则高级字段、记忆、备份、预设和扩展面板还有中文固定文本；后端错误/规则理由也尚未完整本地化。尚缺全部界面的键盘导航、读屏、长文本、缩放和 WCAG 2.2 AA 实际审计。当前工作仅完成 U05 的基础及首批页面，清单必须保持开放。

## 源码验证

首次真实桌面重启检查发现插件 locale 覆盖 `document.lang` 的竞态；失败报告 `renderer-data-workflows-k02-u05-20261002-r1.json` 保留。修复后，`renderer-data-workflows-k02-u05-20261003-r2.json` 的 12 阶段通过，其中最后一阶段通过真实中文/英文界面选择、共享设置保存、关闭、新服务端口和新窗口恢复。SHA-256 为 `86d162e27bc0789356fb30c1176392e989415cdc074010eb6f7cb9bc6295244d`。这是源码 Electron 报告，尚未覆盖新的正式 EXE。

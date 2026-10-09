# MyCompanion

**面向新人的开源 Windows AI 角色扮演桌面软件——导入一张角色卡，就能开始一段有长期记忆的故事。**

![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D4)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-339933)

**角色卡 · 世界书 · 正则脚本 → MyCompanion → 有记忆的多轮对话 → 你选择的模型服务**

🤔 下载了一堆角色卡，却被部署、扩展和配置挡在门外？

💾 聊了很久的角色，换一台机器、换一个工具就什么都不记得了？

🔍 想知道每一次回复到底用了哪些记忆、世界书和提示词，而不是一个黑盒？

✨ 功能速览 · 🧱 独立实现 · ⚡ 快速开始 · 📦 构建发布 · 🗂️ 目录结构 · ⚠️ 注意 · 📄 许可

---

## ✨ MyCompanion 能做什么

基于独立的 Electron、React、Fastify 与 SQLite，开箱即用：

| | 能力 | 说明 |
| --- | --- | --- |
| 🎴 | **角色卡** | Character Card V2/V3（PNG/JSON）、BYAF/CHARX 导入导出，直接使用现有角色卡资源 |
| 🧠 | **长期记忆** | 摘要、向量检索与记忆诊断，每段故事独立成局 |
| 📖 | **世界书** | 关键词触发、向量匹配与深度注入 |
| ✂️ | **正则管线** | 酒馆兼容的正则脚本，作用于提示词与显示文本 |
| 🔌 | **多供应商** | 兼容 OpenAI 协议的各类模型服务接入 |
| 👁️ | **提示词预览** | 发送前查看完整提示词与逐区 token 估算，生成过程不黑盒 |

---

## 🧱 独立实现，而非套壳

MyCompanion 是独立的角色聊天应用：**不内置、不运行也不分发 SillyTavern 等项目的完整前后端**，不提供酒馆助手（JS-Slash-Runner）兼容宿主，也不安装任何第三方扩展。兼容范围仅限于角色卡等数据格式。

唯一的例外是**角色卡自带界面**：卡片自带的 HTML/CSS/JS 在独立子文档（srcdoc iframe）中渲染，卡片 CSS 不会污染应用界面。

> ⚠️ **卡脚本是可信的高权限代码**：按产品决策，它可以访问应用数据与网络——请只导入你信任的卡片，导入含脚本的卡片时应用会显式要求确认。

本地服务仅监听 127.0.0.1 随机端口、随桌面退出，并要求 per-session 请求令牌，本机其他进程与浏览器网页无法直连。

---

## ⚡ 快速开始

要求 Node.js ≥ 22.12、npm ≥ 11。

```powershell
npm ci
npm run check
npm run dev:desktop
```

主窗口运行自有桌面界面，用户资料存于 Electron 的每用户应用目录。Electron 保持 sandbox 与 contextIsolation，关闭 Node integration；应用页面本身不加载第三方脚本。

---

## 📦 构建与发布

Windows x64 便携候选构建：

```powershell
npm run build:desktop
npm run package:win
```

产物写入 `.cache/packaging/candidates/<timestamp>/`，包含候选 EXE、对应源码归档、manifest、完整检查日志和 `candidate.json`。这一步不会替换正式版。源码归档包含可复现测试所需的合法自有夹具及注明来源的公共参考；运行资源排除测试夹具与用户数据库。`afterPack` 核对实际资源与冻结输入，不能只凭文件名宣称对应源码。

满足所有发布门槛后，晋升正式版：

```powershell
npm run promote:release -- --candidate <candidate.json> --acceptance <acceptance.json>
```

`release` 保持一个正式 EXE，`output` 为空；开发产物尚未签名。发布门槛与晋升流程属于内部资料，不随公开仓库分发。

---

## 🗂️ 目录结构

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 宿主、关闭与发布验收 |
| `apps/local-service` | 数据、模型协议、记忆与生成服务 |
| `apps/renderer` | 独立桌面界面 |
| `packages/character-card` | 角色卡解析、资产与格式往返 |
| `packages/shared` | API schema 与共享类型 |

---

## 📚 文档

`docs/` 收录面向贡献者的技术设计文档：

- 桌面端：[关闭验收边界](docs/desktop-editor-boundaries.md)、[诊断与无障碍](docs/desktop-diagnostics-accessibility.md)、[前台生成](docs/desktop-foreground-generations.md)、[回复窗口](docs/desktop-reply-windows.md)
- 角色卡：[归档界面](docs/character-archive-ui.md)、[宏阶段](docs/character-macro-phases.md)
- 生成与记忆：[生成参数](docs/generation-parameters.md)、[token 核算](docs/token-accounting.md)
- 世界书：[编辑器](docs/world-info-editor.md)、[运行时](docs/world-info-runtime.md)
- 供应商：[协议](docs/provider-protocols.md)、[任务路由](docs/provider-task-routing.md)
- 界面：[本地化](docs/ui-localization.md)

---

## ⚠️ 注意

> **当前没有正式发行版。** 旧的 `MyCompanion-0.2.1-windows-x64.exe`（兼容层移除前构建）已于 2026-10-03 清理；下一个正式版须从新候选晋升，内部候选及源码专项结果不能归到旧包。

- 只导入你信任的卡片——卡脚本以完整权限运行
- 真实模型配置与费用限额、至少五名真人、有效安全联系和分发渠道仍需实际取得；脚本或空表不代替这些证据

---

## 📄 许可与贡献

项目许可为 [AGPL-3.0-only](LICENSE)，复用范围与第三方许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全联系状态见 [SECURITY.md](SECURITY.md)。

# MyCompanion

面向新人的开源 Windows AI 角色扮演桌面软件。使用独立 Electron、React、Fastify 与 SQLite，支持角色卡、长期记忆、世界书、正则与多供应商模型接入。

MyCompanion 是独立的角色聊天应用，不是 SillyTavern 等开源项目的套壳：不内置、不运行也不分发完整酒馆前后端，不提供第三方 JS/CSS 扩展或酒馆助手兼容宿主。兼容范围限于角色卡等数据格式（Character Card V2/V3 的 PNG/JSON，以及 BYAF/CHARX 等导入导出），方便新人使用现有角色卡资源。具体支持见 [当前支持矩阵](docs/current-support.md)，推进状态见 [37项清单](docs/project-todo.md) 和 [实施证据](docs/history/checklist-implementation.md)。产品要求与发布门槛分别见 [spec.md](spec.md) 和 [test.md](test.md)。历史记录已移至 [README 历史](docs/history/independent-readme-history.md)。

要求 Node.js ≥22.12、npm ≥11。开发环境运行：

```powershell
npm ci
npm run check
npm run dev:desktop
```

主窗口运行自有桌面界面；内部服务仅监听随机 127.0.0.1 端口，随桌面退出。用户资料存于 Electron 的每用户应用目录。Electron 保持 sandbox、contextIsolation，关闭 Node integration；界面不加载或执行任何第三方脚本。

Windows x64 便携候选构建：

```powershell
npm run build:desktop
npm run package:win
```

产物写入 `.cache/packaging/candidates/<timestamp>/`，包含候选 EXE、对应源码归档、manifest、完整检查日志和 `candidate.json`。这一步不会替换正式版。源码归档包含可复现测试所需的合法自有夹具及注明来源的公共参考；运行资源排除测试夹具与用户数据库。`afterPack` 核对实际资源与冻结输入，不能只凭文件名宣称对应源码。

满足所有发布门槛后，使用 `npm run promote:release -- --candidate <candidate.json> --acceptance <acceptance.json>` 晋升。流程与中断恢复见 [发布文档](docs/release-workflow.md)。`release` 保持一个正式 EXE，`output` 为空；开发产物尚未签名。旧的 `MyCompanion-0.2.1-windows-x64.exe`（兼容层移除前构建）已于 2026-10-03 清理，**当前没有正式发行版**；下一个正式版须从新候选晋升。内部候选及源码专项结果不能归到旧包。

目录职责：

| 路径 | 职责 |
| --- | --- |
| apps/desktop | Electron 宿主、关闭与发布验收 |
| apps/local-service | 数据、模型协议、记忆与生成服务 |
| apps/renderer | 独立桌面界面 |
| packages/character-card | 角色卡解析、资产与格式往返 |
| packages/shared | API schema 与共享类型 |

项目许可为 [AGPL-3.0-only](LICENSE)，复用范围与第三方许可见 [第三方声明](THIRD_PARTY_NOTICES.md) 与 [来源追踪](docs/source-tracking.md)。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全联系状态见 [SECURITY.md](SECURITY.md)。真实模型配置与费用限额、至少五名真人、有效安全联系和分发渠道仍需实际取得；脚本或空表不代替这些证据。

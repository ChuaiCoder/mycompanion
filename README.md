# MyCompanion

面向新人的开源 Windows AI 角色扮演桌面软件。使用独立 Electron、React、Fastify 与 SQLite，支持角色卡、长期记忆、世界书、正则，以及通过 Git URL 安装并运行酒馆扩展的 JS/CSS。

兼容目标是固定 SillyTavern 1.19.0；完整酒馆助手公开域、生成模式、真人新人测试和固定真实模型质量仍有未完成项。具体支持见 [当前支持矩阵](docs/current-support.md)，推进状态见 [37项清单](docs/project-todo.md) 和 [实施证据](docs/checklist-implementation.md)。产品要求与发布门槛分别见 [spec.md](spec.md) 和 [test.md](test.md)。历史记录已移至 [README 历史](docs/independent-readme-history.md)。

要求 Node.js ≥22.12、npm ≥11。开发环境运行：

```powershell
npm ci
npm run check
npm run dev:desktop
```

主窗口运行自有桌面界面；内部服务仅监听随机 127.0.0.1 端口，随桌面退出。用户资料存于 Electron 的每用户应用目录。已启用扩展拥有酒馆前端能力；Electron 保持 sandbox、contextIsolation，关闭 Node integration。

Windows x64 便携候选构建：

```powershell
npm run package:win
```

产物写入 `.cache/packaging/candidates/<timestamp>/`，包含候选 EXE、对应源码归档、manifest、完整检查日志和 `candidate.json`。这一步不会替换正式版。源码归档包含可复现测试所需的合法自有夹具及注明来源的公共参考；运行资源排除测试夹具、用户数据库、私卡和助手代码。`afterPack` 核对实际资源与冻结输入，不能只凭文件名宣称对应源码。

满足所有发布门槛后，使用 `npm run promote:release -- --candidate <candidate.json> --acceptance <acceptance.json>` 晋升。流程与中断恢复见 [发布文档](docs/release-workflow.md)。`release` 保持一个正式 EXE，`output` 为空；开发产物尚未签名。正式版当前仍为旧版 `MyCompanion-0.2.1-windows-x64.exe`，SHA-256 `722dce179165fcf8df3c9b1c0e47968941a1bf2dc5cfcd1fa926bd2bcb1d30a5`。内部候选及源码专项结果不能归到该旧包。

目录职责：

| 路径 | 职责 |
| --- | --- |
| apps/desktop | Electron 宿主、关闭与发布验收 |
| apps/local-service | 数据、模型协议、记忆与扩展运行 |
| apps/renderer | 独立桌面界面 |
| packages/character-card | 角色卡解析、资产与格式往返 |
| packages/shared | API schema 与共享类型 |
| packages/macro-engine | 合法复用与适配的酒馆宏引擎 |

项目许可为 [AGPL-3.0-only](LICENSE)，复用范围、第三方许可和固定来源见 [第三方声明](THIRD_PARTY_NOTICES.md) 与 [来源追踪](docs/source-tracking.md)。完整酒馆应用不打包或运行。酒馆助手另受 PolyForm Noncommercial 1.0.0 约束，只在符合其许可的隔离验收中读取，不进入本项目 EXE 或对应源码包。用户可通过扩展 URL 自行安装。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全联系状态见 [SECURITY.md](SECURITY.md)。真实模型配置与费用限额、至少五名真人、有效安全联系和分发渠道仍需实际取得；脚本或空表不代替这些证据。

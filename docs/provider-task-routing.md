# 多提供商与任务模型路由

P02 源码阶段完成于 2026-10-03。此记录不代表最终 EXE 已更新，也不代表真实模型的记忆质量已通过 G04。

## 开源比较与适配

比较了固定 SillyTavern 1.19.0 的 connection-manager 与 OpenAI/Ollama vectors、Vercel AI SDK、LibreChat 和官方 ollama-js。酒馆固定提交为 `7e8663cd9c184a550b37238218bdd32c6efc68e9`，AGPL-3.0-only；AI SDK 为 Apache-2.0，LibreChat/ollama-js 为 MIT。完整读取的研究材料与适配成本见 `.cache/reports/p02-provider-routing-research-20261003.md`。

采用连接 ID 与显示名称分离、每项任务独立选择、每次调用固定快照的设计。酒馆账户/命令驱动 UI、LibreChat Mongo/auth 和 AI SDK 完整依赖栈不适合直接搬入当前 SQLite 桌面程序；没有为保存配置安装新 SDK。Embedding 适配与固定向量方法的实际来源、许可证和哈希记录于项目内部研究资料。GitHub metadata 受限，未声称重新确认上游维护日期；npm 发布日期仅为已取得的包元数据证据。

## 实际行为

`ProviderRepository` 管理连接和四种任务指派。原 singleton 一次迁移成稳定 `default` 连接，保留 Electron safeStorage ciphertext；旧 `getProvider`、`saveProvider` 与酒馆设置/预设接口继续操作当前聊天连接。连接显示名称允许重复，ID 唯一；删除连接同步重分配聊天并清除其他引用，最后一个连接可编辑但不能删除。

聊天始终选择一个连接。摘要与记忆提取未指派时使用聊天连接，二者独立执行，失败不把用户内容转发给另一个服务。Embedding 必须显式指派；未配置、冷索引、接口或格式失败均使用关键词召回并返回原因。普通生成、预览、quiet、公开组装与记忆测试器都经过实际语义检索；controlled 向量只证明传输和机制。

每次调用同步取得配置与 ciphertext 快照，原生 browser preflight 同时收到无秘密的提供商快照。生成期间更换聊天连接不改变当前请求，下一次发送才使用新连接。扩展仍可修改本次请求；保存的密钥只在相同协议与完整有效 endpoint 路径内复用，显式 proxy password 或自定义 Authorization 仍由扩展控制。

界面保留当前聊天连接的简单表单，并提供已保存连接选择。高级面板管理连接、四种任务及专用 Embedding 测试。编辑连接或切换聊天连接会清空未提交的密钥草稿。API、renderer、备份只包含 `hasApiKey`，不包含明文或 ciphertext。备份保存非秘密配置和任务映射；旧备份仍可校验，恢复不导入密钥，全新默认占位连接可正确恢复。

## 验证证据

| 验证 | 完成证据与边界 |
| --- | --- |
| 后端 | `p02-task-routing-20261003-r2.log`：10 文件 / 86 项通过。真实 loopback HTTP、旧 SQLite 迁移/重启、四任务目标/模型/密钥、失败隔离、删除/指派原子性、备份及 native preflight 快照。 |
| Renderer | `p02-provider-ui-20261003-r2.log`：3 文件 / 12 项通过；service 与 renderer 类型检查通过。 |
| 实际 Electron | `renderer-provider-profiles-p02-20261003-r4.json`：6 阶段、30 次实际传输、consoleErrors 为空。实际 React CRUD、safeStorage、密钥草稿清理、任务选择、七次聊天与后台/vector 请求、中途切连接、新端口重启。SHA-256 `bf9e38ec65fbe6e50ef45d2d64a13ebf6ae0ac79cac64a9f38806a1ae1478aa0`。 |
| 错误回显 P0 | `provider-error-echo-before-20261003.json` 六项泄漏为 true；`provider-error-echo-after-20261003.json` 全为 false。覆盖 native SSE、失败消息、备份、公开补全、raw 和连接测试。固定分类保留 HTTP 状态；原始错误体和 transport exception 不进入持久状态。专项 `provider-error-boundaries-20261003-r3.log`：5 文件 / 43 项。 |
| 路径 override P0 | `provider-override-scope-before-20261003.json`：同 host 新路径收到旧 key；对应 after 报告 Authorization 为 null。完整路径比较也用于公开请求，不再仅检查 origin。 |

报告均在 `.cache/reports/`，测试数存在重叠，不累加代替最终全量 gate。旧失败和 r1/r2/r3 Electron 报告保留；只有 r4 是此功能完整通过证据。P01 的原生 Claude/Gemini、生成模式、真实工具续轮、媒体/音频仍需独立实现与验证。最终冻结源码、同一新 EXE、真实模型质量与费用、真人新人流程仍开放。

# 世界书运行时、向量激活与快捷回复自动化

目标固定为 SillyTavern 1.19.0，commit `7e8663cd9c184a550b37238218bdd32c6efc68e9`。本项目沿用 AGPL-3.0-only：扫描器、向量编排和快捷回复执行核心直接抽取该固定源码；独立 Electron 文档、原生数据与本地服务负责宿主适配。没有嵌入整套酒馆应用。

## 调用阶段

角色卡第一次完整读取在世界书扫描之前。本轮卡描述里的 `{{outlet::name}}` 因而保留已有或空值；不能重新展开整张卡来刷新 Outlet，否则 `incvar` 等宏也会重复执行。扫描后先运行真实 `WORLD_INFO_ACTIVATED` 监听器，再安装新的 `customWIOutlet_` NONE 提示词。独立后续扩展/自定义提示词会读取新 Outlet。公开世界书 API 返回 Outlet 分组，不会自行安装。

`WORLDINFO_SCAN_DONE` 在每轮扫描尾部 await 所有监听器。条目引用、共享对象、循环、Array、Map、Set 和 TimedEffects 实例状态经数据图桥接返回扫描器。原生遍历因异步宏重播时消费已完成的 effect ordinal，不会重跑监听器。函数、Symbol 和任意 DOM/宿主对象不是可传输数据；此处不声称这些对象能跨本地服务 RPC 保持行为。

正常与 quiet 调用在完成 preflight、接受请求时原子提交变量、世界书计时状态与助手占位。接受后模型服务失败仍保留计时状态。预览、公开 dry-run 与接受前取消不会提交。用户切换/编辑分支会先挂载该分支兼容的计时快照，扩展随后直接修改 `timedWorldInfo` 会被本分支采用；离开分支时保留这些显式修改。内部重新生成分支仍只在原有接受事务中提交，未放宽 revision、分支或消息前缀检查。

## 世界书向量激活

在模型配置中显式为 Embedding 任务选择连接。自动世界书向量激活使用 `extension_settings.vectors` 的 `enabled_world_info`、`enabled_for_all`、`query`、`max_entries` 和 `score_threshold`。条目以其 `vectorized` 字段选择是否索引，除非启用所有条目。当前连接支持 OpenAI compatible/custom 与 Ollama 的真实 Embedding HTTP；不会默认借用聊天连接、生成随机向量或以关键词评分冒充语义检索。

正常/重新生成在扫描前执行固定源码的 `getQueryText` 和 `activateWorldInfo`：去掉附件前缀，对消息保留两次真正的宏展开，选择最新消息并折叠换行；按 world 分组、同步内容 hash、索引新内容、删除旧内容；使用原版 `multiQueryCollection` 按所有集合的分数排序、阈值筛选后取一个全局 top-K；映射回本轮已选来源并发送真实 `WORLDINFO_FORCE_ACTIVATE`。相同内容 hash 匹配多个当前条目的行为保留，后续扫描仍过滤禁用条目。

向量网络请求使用同一次调用的 Embedding profile、模型与密钥快照。查询期间角色或所选世界书发生变化会丢弃旧结果并给出诊断。配置缺失、密钥不可读、不支持 Embedding、HTTP 失败与索引失效也给出明确诊断，其他生成阶段仍可继续。

与固定酒馆一致，quiet 与预览不自动运行这个向量 interceptor；公开世界书 API也不自动运行。扩展可自行使用集合 API、FORCE event 和公开扫描。`/api/vector/list|insert|delete|query|query-multi|purge|purge-all` 提供酒馆 JSON 形状。`source/model` 旧参数可接收，实际执行使用已指定的 Embedding 任务连接；并未实现所有酒馆向量供应商。单集合 query 的 hashes 和 metadata 都遵守阈值，未复制上游 hashes 忽略阈值的问题。

用户向量集合使用 `vector:<collectionId>` 命名空间，与私有记忆的 `memory` 命名空间分离。集合 purge-all 不删除记忆；集合 API也不能扩大原生记忆的来源可见性。集合向量属于可重建缓存，不成为备份事实；原始世界书、记忆与连接配置保留在现有备份中。

## 世界书快捷回复自动化

真正复用 `AutoExecuteHandler.handleWIActivation`、`QuickReply.execute`、`QuickReplySet.executeWithOptions` 和 named `/run` 查找核心。`WORLD_INFO_ACTIVATED` 收到 `automationId` 后，按全局、聊天、角色配置顺序匹配已加载回复集并 await 真实 Slash 执行；重复配置保留上游的重复执行行为，`preventAutoExecute` 阻止嵌套自动执行，某个回复失败会告警并继续后续回复。

原生事实存储提供 `POST /api/quick-replies/save`、`POST /api/quick-replies/delete`、`GET /api/quick-replies/list`。酒馆的 `POST /api/settings/get` 返回 `quickReplyPresets`；固定 `loadSets` 也保留旧版 JSON 的迁移。预设存在现有 SQLite settings 内部字段 `__mycompanion_quick_reply_presets`，普通 settings 替换不会误删这些事实，显式导入/备份覆盖仍生效。

配置形状：

```json
{
  "quickReplyV2": {
    "isEnabled": true,
    "config": { "setList": [{ "set": "World automation" }] },
    "characterConfigs": {
      "character.png": { "setList": [{ "set": "Character automation" }] }
    }
  }
}
```

聊天配置在 `chat_metadata.quickReply.setList`。预设 JSON 示例：

```json
{
  "version": 2,
  "name": "World automation",
  "qrList": [{
    "id": 1,
    "label": "Count activation",
    "automationId": "world-count",
    "message": "/incvar activationCount | /incglobalvar activationCount"
  }]
}
```

启用 `quickReplyV2` 并把世界书条目 `automationId` 设为 `world-count`。浏览器初次启动加载预设，原生程序化导入后可调用 `/plugin-runtime/quick-reply.js` 的 `loadQuickReplies()` 刷新。本轮自动化中的变量写入与其他浏览器 effect 共同返回原生 draft；未接受时不单独保存。调用取消或切换故事会中止等待中的 Slash 命令，后续回复不会写入旧故事。

当前阶段完成世界书自动化与 named `/run` 执行核心，普通文本回复的原 textarea 写入/按钮点击通过宿主适配同步现有 React composer，仍遵守原回复集 `disableSend` 与真实按钮的禁用状态。尚未提供完整快捷回复管理界面、按钮/上下文菜单、编辑器调试或所有其他自动执行事件。手动聊天输入 Slash 入口绑定现有原生 composer 与执行器，没有复用酒馆专属脚本进度 DOM。

## 来源与验证

可重现抽取脚本为 `scripts/import-world-info-upstream.mjs`、`scripts/import-world-info-vectors.mjs` 和 `scripts/import-quick-reply-upstream.mjs`；SHA 与适配范围见本地服务相应 upstream JSON 及根目录 `THIRD_PARTY_NOTICES.md`。向量距离复用 MIT Vectra 的 metric，Embedding HTTP 客户端与记忆检索共用。RisuAI 的 GPL-3.0 实现仅比较设计，没有复制到产品。酒馆助手 PolyForm Noncommercial 研究夹具不进入产品或源码包。

原算法 oracle 从固定 checkout 直接抽取未修改的声明进入 VM，再和产品的真实执行路径比较；产品 adapter 不充当自己的参考。已有向量 oracle 比较全局 top-K、编辑/删除、重复内容、阈值、双宏展开与真实 HTTP 请求；快捷回复 oracle 比较配置顺序、重复配置、嵌套保护和错误后的继续执行。原生 HTTP 用 normal/quiet/preview 验证自动化只执行一次、后续提示词读取新变量、接受后持久化与预览不写。

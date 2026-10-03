# 世界书运行时与向量激活

目标固定为 SillyTavern 1.19.0，commit `7e8663cd9c184a550b37238218bdd32c6efc68e9`。本项目沿用 AGPL-3.0-only：扫描器与向量编排核心直接抽取该固定源码；独立 Electron 文档、原生数据与本地服务负责宿主适配。没有嵌入整套酒馆应用。

2026-10-03 起快捷回复自动化、Slash 命令、quiet 调用与扩展监听（`WORLD_INFO_ACTIVATED` 等酒馆事件总线）已随兼容层整体移除。世界书扫描与向量激活仍按本文执行，但不再触发任何第三方自动化；对应接口（`/api/quick-replies/*`、`/plugin-runtime/*`）已删除。

## 调用阶段

角色卡第一次完整读取在世界书扫描之前。本轮卡描述里的 `{{outlet::name}}` 因而保留已有或空值；不能重新展开整张卡来刷新 Outlet，否则 `incvar` 等宏也会重复执行。扫描完成后安装新的 `customWIOutlet_` NONE 提示词，后续提示词组装读取新 Outlet。公开世界书 API 返回 Outlet 分组，不会自行安装。

正常调用在请求被接受时原子提交变量与世界书计时状态；接受后模型服务失败仍保留计时状态。预览与接受前取消不会提交。用户切换/编辑分支会先挂载该分支兼容的计时快照；离开分支时保留这些显式修改。内部重新生成分支仍只在原有接受事务中提交，未放宽 revision、分支或消息前缀检查。

## 世界书向量激活

在模型配置中显式为 Embedding 任务选择连接。自动世界书向量激活使用 `extension_settings.vectors` 的 `enabled_world_info`、`enabled_for_all`、`query`、`max_entries` 和 `score_threshold`。条目以其 `vectorized` 字段选择是否索引，除非启用所有条目。当前连接支持 OpenAI compatible/custom 与 Ollama 的真实 Embedding HTTP；不会默认借用聊天连接、生成随机向量或以关键词评分冒充语义检索。

正常/重新生成在扫描前执行固定源码的 `getQueryText` 和 `activateWorldInfo`：去掉附件前缀，对消息保留两次真正的宏展开，选择最新消息并折叠换行；按 world 分组、同步内容 hash、索引新内容、删除旧内容；使用原版 `multiQueryCollection` 按所有集合的分数排序、阈值筛选后取一个全局 top-K；映射回本轮已选来源。相同内容 hash 匹配多个当前条目的行为保留，后续扫描仍过滤禁用条目。

向量网络请求使用同一次调用的 Embedding profile、模型与密钥快照。查询期间角色或所选世界书发生变化会丢弃旧结果并给出诊断。配置缺失、密钥不可读、不支持 Embedding、HTTP 失败与索引失效也给出明确诊断，其他生成阶段仍可继续。

与固定酒馆一致，预览不自动运行这个向量 interceptor；公开世界书 API 也不自动运行。`/api/vector/list|insert|delete|query|query-multi|purge|purge-all` 提供酒馆 JSON 形状。`source/model` 旧参数可接收，实际执行使用已指定的 Embedding 任务连接；并未实现所有酒馆向量供应商。单集合 query 的 hashes 和 metadata 都遵守阈值，未复制上游 hashes 忽略阈值的问题。

用户向量集合使用 `vector:<collectionId>` 命名空间，与私有记忆的 `memory` 命名空间分离。集合 purge-all 不删除记忆；集合 API 也不能扩大原生记忆的来源可见性。集合向量属于可重建缓存，不成为备份事实；原始世界书、记忆与连接配置保留在现有备份中。

## 来源与验证

可重现抽取脚本为 `scripts/import-world-info-upstream.mjs` 和 `scripts/import-world-info-vectors.mjs`；SHA 与适配范围见本地服务相应 upstream JSON 及根目录 `THIRD_PARTY_NOTICES.md`。向量距离复用 MIT Vectra 的 metric，Embedding HTTP 客户端与记忆检索共用。RisuAI 的 GPL-3.0 实现仅比较设计，没有复制到产品。酒馆助手 PolyForm Noncommercial 研究夹具不进入产品或源码包。

原算法 oracle 从固定 checkout 直接抽取未修改的声明进入 VM，再和产品的真实执行路径比较；产品 adapter 不充当自己的参考。已有向量 oracle 比较全局 top-K、编辑/删除、重复内容、阈值、双宏展开与真实 HTTP 请求。

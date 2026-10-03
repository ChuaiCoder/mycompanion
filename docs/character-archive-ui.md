# 桌面角色卡档案导入

2026-10-03。本轮 C01 renderer 与源码 Electron 证据；不代表完整 C01 验收或正式 EXE 已更新。

沿用同一个角色卡文件选择入口和导入预览。支持多选 PNG、JSON、YAML、CHARX、ZIP、BYAF，以及 JPEG 封面后拼接 ZIP 的角色卡；真实 PNG 签名优先于文件名，非 PNG 二进制保持原始 File 上传。普通 JPEG 没有角色卡数据时显示明确错误，不把图片当作 JSON。YAML 原始文本交给后端解析与转换，旧格式预览明确提醒检查转换后的 V2，未知字段保留。BYAF 预览显示实际故事数，确认后才写入消息和回复分支。20 MiB 上传上限保留。导入失败、重复打开、独立副本、指定角色 ID/revision 替换与重试共用既有流程。

预览显示后端实际识别的随卡文件数，明确确认之后才写入。SQLite 保存包内引用及未引用辅助文件，角色库侧栏和详情从真实头像接口显示 JPEG/PNG，图片读取失败则保留姓名首字。外部 URI 保留原文，导入时不下载；卡片内的脚本文件作为资产保存，不作为已安装扩展执行。

导出操作提供 JSON、PNG、CHARX。JSON 只保留角色设定；PNG 使用 V3 资产文本块，路径受文本块长度与 Latin-1 编码限制；完整资产迁移优先使用 CHARX。完整备份保留二进制资产。后端格式研究、固定 SillyTavern/RisuAI/V3 specification 的许可证与适配判断见 [character-asset-research.md](character-asset-research.md)，本界面使用现有 React/API 流程，没有引入另一套安装或迁移入口。

## 已通过的实际桌面验证

`apps/desktop/scripts/verify-renderer-character-archives.mjs` 使用独立 profile、真实 React/SQLite、原生下载与实际关闭钩子。报告 `.cache/reports/renderer-character-archives-c01-charx-20261003-r2.json`，checkedAt 为 `2026-10-02T16:50:22.992Z`，SHA-256 为 `363d9314f8add0cba62126659b371f78e9d2282f4a79e1f3cf55ca4c305b739d`。

六个阶段全部通过：实际 JPEG 封面 CHARX 预览并显示四个资产；原始二进制导入和侧栏/详情实际 JPEG 显示；原生 CHARX 下载保留未知元数据、外部 URI 和所有附件字节；重复打开与替换保留角色 ID、既有故事和附件；原生完整备份、实际 UI 选文件覆盖恢复；真实关闭后新服务端口/profile 重启恢复头像、附件和未提交角色草稿。

首轮 r1 的失败报告保留：自编 harness 点击导航后读取尚未提交的 React 页面。补实际节点等待后 r2 通过，没有放宽产品断言。r2 对应首次 CHARX 后端，不能据此声称后续 PNG 资产块或更换头像已经验收。当前 API 与组件专项三文件十四项通过；后续新增功能的全套测试和桌面报告分别记录。

随后使用最新 PNG 资产实现运行独立 r3。报告 `renderer-character-archives-c01-png-charx-20261003-r3.json`，checkedAt 为 `2026-10-02T17:02:26.988Z`，SHA-256 为 `9846eb8e8032460eacb01f2f5328e7e3b1d248b5dd530670373ddacb3b164a0e`。八个阶段通过：重跑上述六阶段，并增加原生 PNG 资产下载、实际 UI 重导、CHARX 附件逐字节往返，以及实际 PNG 头像编辑后主 icon 的 URI/ext/字节同步、原 JPEG 和所有辅助文件保留、PNG/CHARX 两格式导出一致。新头像为真实 2×2 PNG，此报告没有验证 JPEG/WebP 裁剪入口。

当前 renderer 全套十五文件八十项通过，类型检查和构建通过。日志 `renderer-c01-e04-m04-20261003-r1.log` 的 SHA-256 为 `ae13682045a751a721c67daac971f47bfdcc56ce2ca0ab290bb45c3f92624866`，包含实际新增的 CHARX API、旧扩展 ref、重新生成分支相邻事件回归；不将先前七十项日志等同于当前源码。

头像入口现支持 PNG、JPEG、WebP。沿用已有 Popup 和 CropperJS 1.6.2（MIT），用 Chromium 解码与 canvas 转换成既有 PNG 上传路径；真实 PNG 可保留原字节。裁剪取消不改草稿，确认时从 Cropper canvas 直接取得 PNG，不使用弹窗兼容返回的 JPEG 再编码。保存和关闭等待进行中的图片转换，转换后的文件及预览进入原有按角色保存的草稿；原角色在明确保存前保持不变。

本设计对照固定 SillyTavern `read_avatar_load`（`public/script.js:7483` 附近），缓存源码 SHA-256 为 `955c603d0bad84bac5a716f0818d85c2543e44d4c43878e0d63ef1e55ca91855`。CropperJS 2 的官方 migration 改为 Web Components API，与当前酒馆扩展和 Popup 1.x 接口适配成本较高，因此复用现有 1.6.2，而不新增图片原生依赖；当前维护和升级风险应与已固定的测试版本分开评估。浏览器本身负责 JPEG/WebP 解码，尺寸和上传限制与既有 PNG 后端一致。

最新报告 `renderer-character-archives-c01-portrait-legacy-20261003-r4.json`，checkedAt 为 `2026-10-02T17:34:34.520Z`，SHA-256 为 `2a00e9d18c3c4e2d0582448bbf574cc5e5fb169311df4496e23e33683040cf3b`。十一阶段通过：重跑资产八阶段，加实际 JPEG 转 PNG 的 6×9 草稿完整关闭/新端口重启恢复、实际 WebP 转 PNG 与裁剪取消、4×6 裁剪保存的全部像素和 CHARX 主图字节一致，以及实际 YAML 文件预览提醒/保存/V2 导出保留未知字段。BYAF UI 已接入，尚不能引用本报告作为其真实桌面流程证据。

随后独立报告 `renderer-character-archives-c01-byaf-20261003-r5.json`，checkedAt 为 `2026-10-02T17:48:44.242Z`，十三阶段通过。新增实际 BYAF 文件预览和两个故事显示、确认前无故事写入、导入后在导航或重启之前 React 故事列表立即出现两条；分别打开两故事核对实际消息 DOM、宿主 `swipes`/`swipe_id`、原始 outputs/未知字段和场景提示词。原生完整备份后实际修改故事，再通过恢复界面覆盖恢复、加载两故事，核对候选回复与全部八个原始文件的 CHARX 字节。自编 BYAF fixture 是本项目回归证据，不能代替固定上游双向交换或原生候选切换 UI。

BYAF r5 报告 SHA-256 为 `275fb4b5aae609d02c09fbb0575c24f427a0dbdda5f7ce8232d3d878117375a4`。

随后独立报告 `renderer-character-archives-c01-inline-20261003-r6.json`，checkedAt 为 `2026-10-02T19:14:23.597Z`，SHA-256 为 `275a3858466ed8012a41224a21e79accb949c7e11f0dee2261311bf134ddb7e5`。十六阶段通过，前十三阶段重新执行；新增实际 data URI JSON 文件选择和角色头像解码、JSON 原 URI/CHARX 内嵌资产原字节/PNG 标准 asset chunk 往返、原生完整备份后实际修改角色并从 UI 覆盖恢复，以及完整关闭后换服务端口重启并从库中打开角色。两种内嵌资源逐字节一致，原始 data URI、未知字段和全部辅助附件保持。

本报告使用最新源码 Electron，不代表旧正式 EXE 已含这些功能。固定上游格式函数双向交换由独立 `scripts/upstream-oracles/character-exchange.mjs` 报告记录，不能用本 UI fixture 代替上游实现。完整 C01 的最终 EXE/V5.3 实卡聊天、世界书和正则演练仍属 G02 的正式候选验收。保存辅助文件不表示所有资源类型已经有消费它们的产品功能。

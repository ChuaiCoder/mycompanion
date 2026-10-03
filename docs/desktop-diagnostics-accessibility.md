# 桌面诊断、本地化与窄窗口操作

核查日期：2026-10-03。这里记录 U05 的已实现子集和实际源码 Electron 验收。U05 仍开放；没有宣称整个应用完成本地化、通过 WCAG 2.2 AA 或经过真人读屏验收。

## 具体改动

沿用已评估的 MIT `i18next` / `react-i18next`，库选择与许可证见 [ui-localization.md](ui-localization.md)。本轮没有引入其他运行依赖，也没有复制其他项目的 UI 字典或样式。

| 入口 | 已实现行为 | 保留的产品语义 |
| --- | --- | --- |
| 本地 token 估算与提供商用量 | 两个原生 disclosure 的标题、字段、全部当前固定 reason、未知 tokenizer、未统计媒体及不完整估算提示有中英文 | 提供商零值和 total 原样显示；差额只比较 input 与本地 promptTokens，最大输出预算不充当输入；reasoning 不重复加到 total |
| 记忆列表、来源、检索与摘要 | 固定标签、状态、应用错误和已知服务诊断有中英文；动态分数、预算、关键词和索引数量随对应文字保留 | 用户内容、来源原文、模型自由说明和 reconciliation reason 保留原文；未知诊断不会被字典的继承属性误识别为译文 |
| 记忆编辑与读取错误 | 编辑后聚焦真实 textarea；保存失败保留草稿，取消或保存成功返回实际编辑按钮；同故事来源刷新保持正在编辑的草稿；首次读取失败有 `role=alert` 和真正重新读取的按钮 | 不静默丢弃失败草稿、不把红色样式当作唯一错误信息 |
| 记忆检索完成 | 使用简短的 status live region 和 `aria-busy`；检索、更新和摘要的迟到结果不覆盖新故事或新来源 revision 的 UI | 只约束组件的显示提交；不是助手 E03 回调来源绑定的解决方案，也没有修改服务保存权限 |
| 世界书向量设置 | 五个真实设置的标题、说明、标签和本地保存失败前缀有中英文 | 继续写既有 `extension_settings.vectors` 和共享保存队列，保持未知字段；键盘操作同一个真实 checkbox |
| 前台生成操作 | “续写回复”/“代写我的消息”有英文按钮文本 | 原生成入口及禁用条件保持既有行为 |

所有原生 input、textarea、select、button、link 和 summary 在主界面中有明确的 `:focus-visible` 轮廓，forced-colors 使用系统 Highlight。来源按钮仍由既有源码聚焦实际消息。焦点样式的实际计算结果经过检查，但没有据此宣称全部颜色对比或焦点遮挡条款通过。

## 发现并修复的重排问题

原 r6 的实际窗口记录显示，200% 缩放时页面有横向溢出，导航只剩导入入口；角色、故事、扩展、记忆和设置入口被旧窄屏规则隐藏。r7 保留了初次修复后仍存在的溢出。

修复使用同一组导航 DOM：820 CSS px 及以下改为可换行的导航布局并继续显示设置 footer，不另外做一套菜单或改变路由。原导航的鼠标和键盘焦点在缩放时继续存在。窄窗口使用 `width:100%`，不再以含垂直滚动条宽度的 `100vw` 撑出页面；移除窄窗口下的 320px 最小宽度，让滚动条出现后可用内容宽度仍能收缩。

实际 320px 检查又确认长 select/表单的固有宽度会撑出设置页的局部滚动容器，角色导出操作也会超出可用宽度。本轮补齐真实控件的 `min-width:0`/`max-width:100%`、设置操作和导出操作换行，以及聊天和导入头部换行。没有用隐藏超出内容来通过检查。

## 实际源码 Electron 证据

验收脚本 verify-renderer-diagnostics.mjs 已随兼容层验证工具一并删除；当时的验收结论保留如下。它运行生产 renderer、实际本地服务、临时 SQLite profile 和真实 HTTP provider fixture，关闭并换新服务端口后重新打开窗口；没有运行或覆盖正式 EXE。

最终报告：`.cache/reports/renderer-diagnostics-u05-20261003-r13.json`，**9 阶段通过**，SHA-256：`4bd672ed623a4ab06fe8f4a79efdf93dd77255a5ebb687e21b36944afa9f796a`。报告记录相应源码 hash 和加载的 renderer HTML hash，`completeU05`、`wcagConformanceClaim` 和 `assistiveTechnologyHumanTested` 都为 false。

| 实际验收 | 结果与边界 |
| --- | --- |
| 提供商 SSE 用量 → 原生 disclosure | 真实 input=0、output=12、total=12、cached=0、reasoning=4 可见；Enter 展开和关闭；不显示 maxTokens=500 为输入 |
| 记忆 GET 503 → 重试 | 文本 alert 提供具体恢复操作；在真实按钮上 Enter 后重新 GET 并显示持久记录 |
| 记忆 PUT 503 → 草稿与焦点 | 实际编辑 textarea 获得焦点；失败保留中文手工草稿；取消回到实际编辑按钮 |
| 来源与检索 | 原生 summary 的 Enter/Space 展开关闭；Tab 到检索操作并显示轮廓；真实检索返回 status 和诊断，保留原消息正文 |
| Accessibility tree | Chromium accessibility tree 具有实际中英文 textbox 名称、status/alert、disclosure expanded 状态；这是引擎树检查，未代替 NVDA 等真人读屏操作 |
| 实际语言选择 | 设置中的真实语言 select 切 English；已显示的错误、token 和检索文字跟随切换，用户内容/检索草稿保持原文 |
| 向量设置 | English 标签；原生 Enter、Tab、Space 控制实际 checkbox；HTTP/SQLite 设置保存并重启恢复 |
| 缩放和窄窗口 | 160%（891×586 CSS px）与 200%（713×469）全部五个主导航按钮和 Settings 可见，既有 Memory 焦点保留，无文档横向溢出；实际 320×900 下角色、故事、扩展、记忆、设置页面既无文档溢出，也没有已检查可见元素撑出局部容器 |
| 六个导航操作 | 320px 下逐项使用 Chromium keyboard / mouse 触发；鼠标命中位置检查未被遮挡，并从其他页面切入以避免“已在当前页”的假阳性；Import 确实由键盘和鼠标到达既有 file input，测试仅拦截其 OS 对话框默认动作，没有宣称原生文件对话框人工验收 |
| 关闭与新端口 | 英文偏好、提供商报告用量、原记忆和键盘保存的向量设置恢复；被拒绝的手工草稿未写入 SQLite |

键盘/鼠标传输是 `Chromium Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`，作用于实际渲染页面并执行原生默认动作，不是 JS click 替代键盘证明。窗口隐藏，避免开启用户正式程序。r1–r5 保留初始化/API/隐藏窗口输入方式、轮廓数值舍入和错误 fixture 预期的失败诊断；r9–r11 保留文件选择观测方法及旧 fixture 编辑器遮挡导致的失败。最终 runner 关闭 fixture 自己打开的角色编辑器，并检查实际鼠标命中，不能将这些早期报告当作最终 mouse 验收。

针对性单元回归：`renderer-diagnostics-targeted-20261003-r3.log`，3 文件 / 13 tests 通过，SHA-256：`5f9a4c05f251378e178801de7b8094966f9ae0f88a7bce51f4d78b8511cb1999`。覆盖英文切换、provider 零值与 total、失败草稿/焦点、读取重试、旧故事迟到提交、已知服务诊断数量和未知自由文本。renderer 类型检查和生产 build 通过；整体检查由根任务统一记录。

## 仍需验收

聊天、角色导入、世界书/正则高级编辑、备份、预设、扩展和后端错误仍有未迁移的固定中文；本轮没有把保留用户/模型原文与应用中文遗漏混为一谈。完整日期/数字格式、任意长内容、全部弹窗/高级展开状态、所有输入交互、键盘焦点遮挡、对比度、减弱动画和跨辅助技术操作仍需逐项完成。320px 已验证的是上述 fixture 的实际主页面和控件，并不代表每个子界面或第三方扩展 UI 已完成重排。完整 WCAG 2.2 AA、至少五名真实新人以及同一最终 EXE 的发布回归保持各自独立门槛。

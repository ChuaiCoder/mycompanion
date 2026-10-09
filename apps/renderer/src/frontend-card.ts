// 前端卡内容识别。
//
// 约定来自社区通行做法：作者把整份 HTML 文档放在 Markdown 代码围栏里，宿主取出代码块
// 原文、交给独立子文档渲染。判定依据是**内容特征**而不是语言标记——很多卡的围栏标记是
// ```html，但也有作者省略标记或用别的词，只看 `html` 标记会漏掉一批卡。
//
// 这里是本项目的独立实现：不复制任何第三方扩展的代码。

/** 一份完整的 HTML 文档结构特征。 */
const DOCUMENT_MARKERS = ["html>", "<head>", "<body"] as const;

/** 整条消息就是一个代码围栏（允许前后有空白）。 */
const WHOLE_MESSAGE_FENCE = /^\s*```[^\n]*\r?\n([\s\S]*?)\r?\n?```\s*$/;

export interface FrontendCard {
  /** 应当放进独立子文档渲染的 HTML 原文。 */
  markup: string;
}

/**
 * 判断一条消息是否是"前端卡"内容，并取出待渲染的 HTML。
 *
 * 只处理"整条消息就是一个围栏"这种形态：这是前端卡的实际写法，同时能避免把聊天里
 * 正常的代码示例（一段 HTML 片段的教学展示）误判成界面。
 */
export function frontendCardOf(content: string): FrontendCard | null {
  if (!content) return null;
  const fenced = WHOLE_MESSAGE_FENCE.exec(content);
  const body = (fenced ? fenced[1]! : content).trim();
  if (!body) return null;
  const markers = DOCUMENT_MARKERS.filter(marker => body.includes(marker)).length;
  if (fenced) {
    // 围栏是作者明确的"这是界面"信号，一个文档特征即可。
    if (!markers) return null;
  } else {
    // 无围栏时收紧：`<p>一段 <body> 文字</p>` 这类提及不该被渲染成界面，
    // 要求至少两个文档级特征（例如 `<html>` + `<head>` 或 `<body>`）。
    if (markers < 2) return null;
  }
  return { markup: body };
}

/** 这份 HTML 里是否含需要执行能力才能工作的脚本。 */
export function hasCardScript(markup: string): boolean {
  return /<script[\s>]/i.test(markup);
}

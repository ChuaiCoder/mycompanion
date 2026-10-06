// 前端卡的隔离渲染。
//
// 为什么隔离：卡片自带的 CSS 会直接写 `body`、`h1`、`:root` 这类选择器，放进主文档会
// 污染整个应用界面；卡片自带的脚本更不该拿到应用页面的任何东西。把它放进**不透明源
// iframe**（sandbox 只给 allow-scripts，不给 allow-same-origin）后：
//   - 同源策略直接切断它对父页面的访问，这是结构性边界，不依赖任何名单；
//   - CSS 天然只作用于该文档；
//   - 脚本照常运行（动画等能力保留）。

/** iframe 的 sandbox：允许脚本，但**不给** allow-same-origin（父页面因此不可达）。 */
export const CARD_IFRAME_SANDBOX = "allow-scripts";

/**
 * 隔离文档的内容安全策略。
 *
 * `default-src 'none'` 是 deny-by-default：网络请求、表单、导航全部拒绝。这一点比名单
 * 更重要——一旦卡脚本能把数据发出去，能力黑名单就没有意义了。
 * `script-src 'unsafe-inline'` 是为卡片自身的 `<script>` 保留执行能力。
 */
export const CARD_IFRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * 拼出隔离文档。
 *
 * 直接把卡片 HTML 放进 `srcdoc`（不做消毒）：消毒会把 `body`/`head` 这类文档级结构连同
 * 内容一起抹掉（实测整段变空），而且治不了 CSS 污染。隔离文档 + 不透明源才是正确的边界。
 */
export function buildCardDocument(markup: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CARD_IFRAME_CSP}">`;
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    meta,
    "<style>",
    // 卡片常按整屏尺寸设计，但它在聊天里是一块内容，需要给它一个稳定的盒子。
    "*,*::before,*::after{box-sizing:border-box}",
    "html,body{margin:0;padding:0}",
    "body{min-height:100%}",
    "</style>",
    "</head>",
    "<body>",
    markup,
    // 测量脚本必须**内联进文档**：iframe 是不透明源，父页面拿不到 contentDocument，
    // 无法从外面注入。文档自身的 CSP 允许内联脚本（这是卡片脚本能跑的前提）。
    `<script>${CARD_HEIGHT_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** 子文档发给父页面的高度消息类型。 */
export const CARD_HEIGHT_MESSAGE = "mycompanion:card-height";

/**
 * 注入到隔离文档里的高度上报脚本。
 *
 * 为什么由子文档自己测：iframe 是不透明源，父页面读不到 `contentDocument`，必须由子文档
 * 测量后 postMessage 上报（这也是父页面唯一能拿到的高度信息）。
 *
 * 为什么要覆盖 `100vh` 卡片：卡片普遍写 `body{min-height:100vh;overflow:hidden}`——
 * 在 iframe 里 `100vh` 等于 iframe 高度，于是**内容比盒子高时会被直接裁掉**（实测截断）。
 * 这里把 `100vh` 重写成"内容实际高度"，让卡片按内容撑开，而不是被视口锁死。
 */
export const CARD_HEIGHT_SCRIPT = `(function () {
  var TYPE = ${JSON.stringify(CARD_HEIGHT_MESSAGE)};
  function post(height) {
    if (!isFinite(height) || height <= 0) return;
    try { parent.postMessage({ type: TYPE, height: Math.ceil(height) }, '*'); } catch (error) {}
  }
  // 把 100vh 展开成内容高度，避免卡片把内容裁掉。
  function relaxViewportUnits(height) {
    var style = document.getElementById('mycompanion-card-height');
    if (!style) {
      style = document.createElement('style');
      style.id = 'mycompanion-card-height';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = 'body{min-height:' + height + 'px !important;overflow:visible !important;align-items:flex-start !important}';
  }
  function measure() {
    var body = document.body;
    if (!body) return;
    var top = body.getBoundingClientRect().top + window.scrollY;
    var bottom = top;
    var children = body.children;
    for (var i = 0; i < children.length; i++) {
      var rect = children[i].getBoundingClientRect();
      var childTop = window.scrollY + rect.top;
      // 装饰性固定层（如全屏 canvas）不参与撑高，否则会把页面推成整屏。
      if (getComputedStyle(children[i]).position === 'fixed') continue;
      if (childTop + rect.height > bottom) bottom = childTop + rect.height;
    }
    var height = Math.max(bottom - top, body.scrollHeight);
    relaxViewportUnits(height);
    post(height);
  }
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(function () { scheduled = false; measure(); });
  }
  function start() {
    measure();
    if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(document.body);
    window.addEventListener('load', schedule);
    window.addEventListener('resize', schedule);
    // 卡片常带入场动画与异步内容，多测几次直到稳定。
    [60, 200, 600, 1500].forEach(function (delay) { setTimeout(schedule, delay); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`;

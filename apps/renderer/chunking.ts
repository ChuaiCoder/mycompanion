/**
 * 构建产物的分块策略。
 *
 * 放在单独文件里是为了可测：构建配置属于 `tsconfig.node.json`（含 node 类型），
 * 而应用与测试代码的 `tsconfig.app.json` 只含浏览器类型，测试里读不了文件系统。
 * 于是把这里做成纯函数，由 `chunking.test.ts` 直接断言，不必依赖"构建是否跑过"。
 *
 * 为什么按角色拆分：以前所有依赖打进一个约 800KB 的 index.js，构建时会报
 * "Some chunks are larger than 500 kB"。那不只是数字问题——所有东西挤在一个文件里时，
 * 改一行应用代码就会让整个文件的缓存失效。拆分**不减少总字节数**（这些都是首屏静态导入），
 * 换来的是缓存粒度：升级某个库时只有它那个 chunk 变化。
 */

/** 各 vendor chunk 的判定顺序：先具体后宽泛，避免 react 抢走 react-i18next 之类。 */
const VENDOR_RULES: ReadonlyArray<{ name: string; test: (id: string) => boolean }> = [
  {
    name: "vendor-react",
    // react-dom 与 react 必须同组：它们共享内部状态，拆开反而引入跨 chunk 依赖。
    test: id => id.includes("react-dom") || id.includes("node_modules/react/") || id.includes("scheduler"),
  },
  {
    name: "vendor-markdown",
    // markdown-it 的解析依赖一并归组，避免它们被塞回入口 chunk。
    test: id => id.includes("markdown-it") || id.includes("dompurify") || id.includes("linkify-it") || id.includes("mdurl") || id.includes("uc.micro"),
  },
  { name: "vendor-i18n", test: id => id.includes("i18next") },
];

/**
 * 把一个模块 id 归入 vendor chunk；返回 undefined 表示交给打包器的默认策略。
 *
 * 只对已知的大依赖显式分组，其余不强行归档：手写一张易失的完整模块清单，
 * 会在依赖升级后悄悄把模块归错组，反而更难排查。
 */
export function vendorChunkOf(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  return VENDOR_RULES.find(rule => rule.test(id))?.name;
}

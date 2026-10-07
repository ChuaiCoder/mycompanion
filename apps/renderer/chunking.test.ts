import { describe, expect, it } from "vitest";

import { vendorChunkOf } from "./chunking.js";

// 分块归组：这些断言不需要构建产物，因此不会因为"没构建"而静默跳过。
describe("构建产物分块", () => {
  it("puts the framework, the markdown stack and i18n into their own chunks", () => {
    expect(vendorChunkOf("/repo/node_modules/react-dom/cjs/react-dom-client.production.js")).toBe("vendor-react");
    expect(vendorChunkOf("/repo/node_modules/react/index.js")).toBe("vendor-react");
    expect(vendorChunkOf("/repo/node_modules/scheduler/index.js")).toBe("vendor-react");
    expect(vendorChunkOf("/repo/node_modules/markdown-it/lib/index.mjs")).toBe("vendor-markdown");
    expect(vendorChunkOf("/repo/node_modules/dompurify/dist/purify.es.mjs")).toBe("vendor-markdown");
    expect(vendorChunkOf("/repo/node_modules/linkify-it/index.mjs")).toBe("vendor-markdown");
    expect(vendorChunkOf("/repo/node_modules/i18next/dist/esm/i18next.js")).toBe("vendor-i18n");
  });

  it("leaves application code and unlisted packages to the bundler", () => {
    // 应用自身代码不能被塞进 vendor chunk，否则改一行就带走整块缓存。
    expect(vendorChunkOf("/repo/apps/renderer/src/main.tsx")).toBeUndefined();
    expect(vendorChunkOf("/repo/packages/shared/src/runtime.ts")).toBeUndefined();
  });

  it("gives react-i18next to i18n rather than letting the react rule take it", () => {
    // 判定顺序错的话，react-i18next 会因为路径里含 "react" 被归到 framework chunk，
    // 那样 i18n 升级就会连带让框架的缓存失效——正是拆分要避免的事。
    expect(vendorChunkOf("/repo/node_modules/react-i18next/dist/es/index.js")).toBe("vendor-i18n");
  });

  it("keeps react and react-dom in the same chunk", () => {
    // 它们共享内部状态；分到两个 chunk 会引入跨 chunk 依赖，不划算。
    expect(vendorChunkOf("/repo/node_modules/react-dom/index.js")).toBe(vendorChunkOf("/repo/node_modules/react/index.js"));
  });
});

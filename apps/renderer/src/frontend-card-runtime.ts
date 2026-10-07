// 卡自带运行时脚本的装载器。
//
// **绝不打包**：这些运行时是第三方内容，因卡而异、各自持证（实测其中至少一个没有
// 任何许可证声明），因此只能在运行时从卡声明的 CDN 拉取，**不得**写入
// `apps/*/public`、仓库或安装包资源。`scripts/package-source.mjs` 的守卫会拒绝
// min.js / 图片 / 视频 / mvu、sillytavern、tavern-helper、daoyuan、js-slash 这类
// 文件名进入源码归档——若将来在此增加本地缓存，请同时确认它不会进入包内。
//
// 卡常把运行时放在 `extensions.tavern_helper.scripts` 里——它们不是消息内的 <script> 标签，
// 而是**数据**，由酒馆助手的"脚本库"读取后作为 ES module 执行。实测这张卡：
//   MVU            → import 'https://…/mvu_bundle_full.js'           （提供 window._ 与 Mvu）
//   ZOD            → import { registerMvuSchema } from '…/mvu_zod.js' （用全局 z，注册变量 schema）
//   道渊配置助手    → import 'https://…/道渊配置小助手.min.js'          （提供 window.Mvu）
//   道渊Wiki       → import('https://…/daoyuan-term-widget.min.js')
//
// 关键约束（都来自实测）：
//  1. **顺序**：MVU 必须先跑完，后续模块才拿得到 `_` 与 `Mvu`；ZOD 还依赖全局 `z`。
//  2. **全局 zod**：MVU 不自带 zod，而 `mvu_zod.js` 直接用裸标识符 `z`（`const r = z`），
//     所以宿主必须先提供 `window.z`。实测 MVU 与 zod-util 里都没有 `window.z = …`。
//  3. 这些模块是远程 ES module，需要 `script-src` 允许外部来源（隔离文档已按需放开）。
//
// 这里只负责"取出来 + 按顺序加载"，不解释脚本内容。

/** 一条卡自带脚本。 */
export interface CardRuntimeScript {
  name: string;
  enabled: boolean;
  type?: string;
  content: string;
}

export interface CardRuntimePlan {
  /** 需要先加载的全局依赖（zod），在卡脚本之前。 */
  prelude: string;
  /** 按顺序加载的卡脚本模块源码。 */
  modules: Array<{ name: string; source: string }>;
}

/** 从原始扩展数据里读出可执行的脚本条目。 */
export function readCardRuntimeScripts(rawExtensions: Record<string, unknown> | undefined): CardRuntimeScript[] {
  const helper = rawExtensions?.tavern_helper;
  if (helper === null || typeof helper !== "object" || Array.isArray(helper)) return [];
  const scripts = (helper as Record<string, unknown>).scripts;
  if (!Array.isArray(scripts)) return [];
  return scripts.flatMap(entry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) return [];
    return [{
      name: typeof record.name === "string" ? record.name : "script",
      enabled: record.enabled !== false,
      ...(typeof record.type === "string" ? { type: record.type } : {}),
      content,
    }];
  });
}

/**
 * 规划加载步骤。
 *
 * 只保留 `type === "script"`（或未标类型）且未被停用的条目：酒馆助手的脚本库里
 * 还可能有别的类型，直接执行它们不是本应用的语义。
 */
export function planCardRuntime(rawExtensions: Record<string, unknown> | undefined): CardRuntimePlan | null {
  const scripts = readCardRuntimeScripts(rawExtensions)
    .filter(script => script.enabled && (script.type === undefined || script.type === "script"));
  if (!scripts.length) return null;
  return {
    // 优先加载宿主级依赖，再跑卡脚本。三样都是实测出来的必需品：
    //  - zod：`mvu_zod.js` 与卡内 ZOD 脚本用裸标识符 `z`；
    //  - lodash：MVU bundle 顶层就用 `_`（实测 ReferenceError: _ is not defined）；
    //  - jQuery：卡内 ZOD 脚本与多个运行时用 `$`（实测 ReferenceError: $ is not defined）。
    // 都挂到全局，因为卡脚本按酒馆运行时的约定直接引用它们。
    prelude: [
      "const load = async (url) => { try { return await import(url); } catch (error) { console.warn('[MyCompanion] 宿主依赖加载失败', url, error); return null; } };",
      // zod 必须用 v4：实测 MVU 用 `.loose()`、卡内 ZOD 脚本用 `.prefault()`，都是 v4 才有的方法。
      // 同时 mvu_zod.js 又要**独立的类全局**（`ZodObject` 等，做 instanceof 判定），
      // 而 v4 的 +esm 构建确实导出了这些名字（实测 260 个命名导出，含 ZodObject/ZodType）。
      "const zod = await load('https://testingcf.jsdelivr.net/npm/zod@4/+esm');",
      "if (zod) {",
      "  window.z = zod;",
      // 实测：mvu_zod.js 读的是 `z.z.ZodObject`（源码 `const r = z; … r.z.ZodObject`），
      // 即它期望全局 z 自身带一个 `z` 命名空间。v4 的 +esm 命名空间没有这个自引用，
      // 所以这里补上；`z.object(...)` 之类的顶层调用不受影响。
      "  if (!window.z.z) { try { Object.defineProperty(window.z, 'z', { value: window.z, enumerable: false, configurable: true }); } catch (error) {} }",
      "  for (const key of Object.keys(zod)) { if (typeof zod[key] === 'function' && /^Zod/.test(key)) window[key] = zod[key]; }",
      "  window.ZodFirstPartyTypeKind = zod.ZodFirstPartyTypeKind ?? window.ZodFirstPartyTypeKind;",
      "}",
      "const lodash = await load('https://testingcf.jsdelivr.net/npm/lodash@4/+esm');",
      "if (lodash && !window._) window._ = lodash.default ?? lodash;",
      "const jquery = await load('https://testingcf.jsdelivr.net/npm/jquery@3/dist/jquery.min.js');",
      "if (jquery && !window.$) { window.$ = jquery.default ?? jquery; window.jQuery = window.$; }",
      "const klona = await load('https://testingcf.jsdelivr.net/npm/klona@2.0.6/+esm');",
      "if (klona && !window.klona) window.klona = klona.klona ?? klona.default ?? klona;",
    ].join("\n"),
    modules: scripts.map(script => ({ name: script.name, source: script.content })),
  };
}

/**
 * 生成注入隔离文档的模块脚本。
 *
 * 每个卡脚本作为**独立模块**加载并逐个 await，保证顺序；单个失败不影响后续，
 * 因为卡里常有互相独立的可选运行时（例如 Wiki 挂件失败不该拖垮 MVU）。
 */
export function buildRuntimeModuleScript(plan: CardRuntimePlan): string {
  const loaders = plan.modules.map((module, index) => [
    `  try {`,
    `    await import(URL.createObjectURL(new Blob([${JSON.stringify(module.source)}], { type: 'text/javascript' })));`,
    `  } catch (error) { console.warn(${JSON.stringify(`[MyCompanion] 卡脚本加载失败：${module.name}`)}, error); }`,
  ].join("\n")).join("\n");

  return [
    "(async () => {",
    plan.prelude,
    loaders,
    "})();",
  ].join("\n");
}

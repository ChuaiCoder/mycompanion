import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const packageRequire = createRequire(import.meta.url);
export interface BrowserAsset { content: Buffer; contentType: string }
let cachedAssets: Map<string, BrowserAsset> | undefined;

// Read from pinned npm dependencies, including inside a packaged ASAR. Never
// depend on a reference Tavern checkout or fetch executable libraries at runtime.
export function getPluginBrowserAssets(): Map<string, BrowserAsset> {
  if (cachedAssets) return cachedAssets;
  const assets = new Map<string, BrowserAsset>();
  const add = (url: string, file: string, contentType = "text/javascript; charset=utf-8") => {
    assets.set(`/plugin-runtime/vendor/${url}`, { content: readFileSync(file), contentType });
  };
  add("jquery.js", packageRequire.resolve("jquery/dist/jquery.min.js"));
  add("lodash.js", packageRequire.resolve("lodash/lodash.min.js"));
  add("handlebars.js", packageRequire.resolve("handlebars/dist/handlebars.min.js"));
  add("macro-engine.js", packageRequire.resolve("@mycompanion/macro-engine"));
  add("cropper.js", packageRequire.resolve("cropperjs/dist/cropper.min.js"));
  add("cropper.css", packageRequire.resolve("cropperjs/dist/cropper.min.css"), "text/css; charset=utf-8");
  add("dompurify.js", join(dirname(packageRequire.resolve("dompurify")), "purify.min.js"));
  add("popper.js", packageRequire.resolve("@popperjs/core/dist/umd/popper.min.js"));
  add("toastr.js", packageRequire.resolve("toastr/build/toastr.min.js"));
  add("toastr.css", packageRequire.resolve("toastr/build/toastr.min.css"), "text/css; charset=utf-8");
  const highlightDirectory = dirname(packageRequire.resolve("@highlightjs/cdn-assets/package.json"));
  add("highlight.js", join(highlightDirectory, "highlight.min.js"));
  const parserDirectory = dirname(packageRequire.resolve("eventsource-parser"));
  for (const file of ["index.js", "parse.js", "errors.js"]) add(`eventsource-parser/${file}`, join(parserDirectory, file));

  const fontDirectory = dirname(packageRequire.resolve("@fortawesome/fontawesome-free/package.json"));
  add("fontawesome/css/all.min.css", join(fontDirectory, "css/all.min.css"), "text/css; charset=utf-8");
  for (const name of ["fa-solid-900", "fa-regular-400", "fa-brands-400", "fa-v4compatibility"]) {
    for (const format of ["woff2", "ttf"]) add(`fontawesome/webfonts/${name}.${format}`, join(fontDirectory, `webfonts/${name}.${format}`), format === "woff2" ? "font/woff2" : "font/ttf");
  }
  const icons = JSON.parse(readFileSync(join(fontDirectory, "metadata/icon-families.json"), "utf8")) as Record<string, { familyStylesByLicense: { free: Array<{ family: string; style: string }> }; aliases?: { names?: string[] } }>;
  assets.set("/plugin-runtime/vendor/fontawesome/icons.json", {
    content: Buffer.from(JSON.stringify(Object.entries(icons).filter(([, icon]) => icon.familyStylesByLicense.free.some(style => style.family === "classic" && style.style === "solid"))
      .map(([name, icon]) => [name, ...(icon.aliases?.names ?? [])].map(value => `fa-${value}`)))),
    contentType: "application/json; charset=utf-8",
  });
  cachedAssets = assets;
  return assets;
}

export const browserLibrarySource = `
// This canonical module is shared by every alias. Top-level await prevents
// consumers from capturing undefined globals during application startup.
for (const [name, globalName] of [['jquery','jQuery'],['lodash','_'],['dompurify','DOMPurify'],['popper','Popper'],['toastr','toastr'],['handlebars','Handlebars'],['cropper','Cropper'],['highlight','hljs']]) {
  if (!globalThis[globalName]) await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/plugin-runtime/vendor/' + name + '.js';
    script.onload = resolve; script.onerror = () => reject(new Error('Unable to load extension library: ' + name));
    document.head.append(script);
  });
}
await Promise.all(['toastr.css', 'cropper.css', 'fontawesome/css/all.min.css'].map(path => new Promise((resolve, reject) => {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/plugin-runtime/vendor/' + path;
  link.onload = resolve; link.onerror = () => reject(new Error('Unable to load extension stylesheet: ' + path));
  document.head.append(link);
})));
export const $ = globalThis.jQuery;
export const lodash = globalThis._;
export const Handlebars = globalThis.Handlebars;
export const Cropper = globalThis.Cropper;
export const DOMPurify = globalThis.DOMPurify;
export const Popper = globalThis.Popper;
export const toastr = globalThis.toastr;
export const hljs = globalThis.hljs;
export default { lodash, DOMPurify, Popper, Handlebars, Cropper };
`;

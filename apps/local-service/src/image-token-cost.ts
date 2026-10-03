import { PNG } from "./image-header-upstream/png.js";
import { JPG } from "./image-header-upstream/jpg.js";
import { GIF } from "./image-header-upstream/gif.js";
import { WEBP } from "./image-header-upstream/webp.js";

interface ImageCost { tokens: number; complete: boolean; reason: "image-rule-estimate" | "unknown-image-size" | "unknown-image-model" }
interface PatchRule { edge: number; budget?: number; multiplier: number }
/** Explicit families from the provider's current sizing table. A guessed
 * suffix/future family must not inherit a rule simply by sharing a prefix. */
function patchRule(model: string, detail: string): PatchRule | undefined {
  const family = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (!["low", "high", "auto", "original"].includes(detail)) return undefined;
  if (family === "gpt-6-astra" || ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].includes(family)) {
    if (detail === "low") return {edge: 512, multiplier: 1.2};
    if (detail === "high") return {edge: family === "gpt-6-astra" ? 65535 : 2048, budget: 2500, multiplier: 1.2};
    return {edge: 65535, multiplier: 1.2};
  }
  if (family === "gpt-5.5" || ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"].includes(family)) {
    if (detail === "low") return family === "gpt-5.5" ? {edge: 512, multiplier: 1.2} : {edge: 2048, budget: 6144, multiplier: 1.2};
    if (detail === "original" || (detail === "auto" && family === "gpt-5.5")) return {edge: 6000, budget: 10000, multiplier: 1.2};
    return {edge: 2048, budget: 2500, multiplier: 1.2};
  }
  if (detail !== "original" && (family === "gpt-5.2" || family === "gpt-4.1-mini"))
    return {edge: 2048, budget: 6144, multiplier: family === "gpt-4.1-mini" ? 1.62 : 1.2};
  return undefined;
}
function patchCount(size: {width: number; height: number}, rule: PatchRule): number {
  const fit = Math.min(1, rule.edge / Math.max(size.width, size.height));
  let width = Math.max(1, Math.floor(size.width * fit)), height = Math.max(1, Math.floor(size.height * fit));
  const patches = (w: number, h: number) => Math.ceil(w / 32) * Math.ceil(h / 32);
  if (rule.budget && patches(width, height) > rule.budget) {
    const shrink = Math.sqrt(1024 * rule.budget / (width * height));
    const coverage = [width, height].map(edge => edge * shrink / 32);
    const adjusted = shrink * Math.min(...coverage.filter(value => value >= 1).map(value => Math.floor(value) / value));
    width = Math.max(1, Math.floor(width * adjusted)); height = Math.max(1, Math.floor(height * adjusted));
    // Floating-point boundary correction cannot enlarge either side. At least
    // one positive pixel remains, even for panoramic or malformed dimensions.
    while (patches(width, height) > rule.budget) {
      const scale = 1 - 1 / Math.max(width, height);
      width = Math.max(1, Math.floor(width * scale)); height = Math.max(1, Math.floor(height * scale));
    }
  }
  return Math.ceil(patches(width, height) * rule.multiplier);
}
/** Documented OpenAI tile models only. Do not apply these constants to Claude,
 * Gemini, patch-based models or unknown compatible endpoints. */
function tileRule(model: string): { base: number; tile: number } | undefined {
  if (/^gpt-4o-mini(?:-|$)/.test(model)) return {base:2833,tile:5667};
  if (/^gpt-4o(?:-|$)|^gpt-4\.1(?:-(?:20\d{2}-\d{2}-\d{2})$|$)|^gpt-4(?:-turbo|-1106-vision-preview)/.test(model)) return {base:85,tile:170};
  if (/^gpt-5(?:\.1)?(?:-(?:20\d{2}-\d{2}-\d{2})$|$)/.test(model)) return {base:70,tile:140};
  if (/^o1(?:-pro)?(?:-(?:20\d{2}-\d{2}-\d{2})$|$)|^o3(?:-(?:20\d{2}-\d{2}-\d{2})$|$)/.test(model)) return {base:75,tile:150};
  return undefined;
}

/** Header-only memory API from image-size (MIT), never remote URL/file I/O.
 * At most 64 KiB of decoded data is enough for common PNG/JPEG/WebP headers;
 * large/exotic headers remain explicitly unknown instead of downloading them. */
function dimensions(url: unknown): {width:number;height:number} | undefined {
  if (typeof url !== "string") return undefined;
  const comma = url.indexOf(",");
  const header = url.slice(0,comma).match(/^data:image\/(png|jpeg|webp|gif);base64$/i);
  if (comma < 0 || !header) return undefined;
  try {
    const handler = {png:PNG,jpeg:JPG,webp:WEBP,gif:GIF}[header[1]!.toLowerCase()];
    const buffer = Buffer.from(url.slice(comma+1,comma+1+87_384),"base64");
    if (!handler || !handler.validate(buffer)) return undefined;
    const size = handler.calculate(buffer);
    if (size.width > 0 && size.height > 0 && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)) return size;
  } catch { /* Invalid/truncated image headers are diagnostics, not raw errors. */ }
  return undefined;
}

export function imageTokenCost(part: Record<string, unknown>, model: string): ImageCost {
  const source = part.image_url;
  const image = source && typeof source === "object" ? source as Record<string,unknown> : {};
  const detail = image.detail ?? part.detail ?? "auto";
  const patch = patchRule(model, String(detail));
  if (patch) {
    const size = dimensions(typeof source === "string" ? source : image.url);
    if (size) return {tokens: patchCount(size, patch), complete: true, reason: "image-rule-estimate"};
    // When no resize budget applies, the documented rejection ceiling is
    // 30,000 patches. This remains explicitly an unknown-size estimate.
    return {tokens: Math.ceil((patch.budget ?? (detail === "low" ? 256 : 30000)) * patch.multiplier), complete: false, reason: "unknown-image-size"};
  }
  const rule = tileRule(model);
  if (!rule || !["low", "high", "auto"].includes(String(detail))) return {tokens:85,complete:false,reason:"unknown-image-model"};
  if (detail === "low") return {tokens:rule.base,complete:true,reason:"image-rule-estimate"};
  const size = dimensions(typeof source === "string" ? source : image.url);
  // Max 8 tiles after fitting within 2048 and downscaling the short side to
  // 768. This is a documented-rule upper estimate for a remote unknown size,
  // not the old fixed low-detail 85-token assumption.
  if (!size) return {tokens:rule.base+8*rule.tile,complete:false,reason:"unknown-image-size"};
  let {width,height}=size;
  const fit=Math.min(1,2048/Math.max(width,height));
  width=Math.max(1,Math.floor(width*fit));height=Math.max(1,Math.floor(height*fit));
  const shorten=Math.min(1,768/Math.min(width,height));
  width=Math.max(1,Math.floor(width*shorten));height=Math.max(1,Math.floor(height*shorten));
  return {tokens:rule.base+Math.ceil(width/512)*Math.ceil(height/512)*rule.tile,complete:true,reason:"image-rule-estimate"};
}

import { describe, expect, it } from "vitest";
import { imageTokenCost } from "./image-token-cost.js";

const cost = (bytes: Uint8Array, mime = "png") => imageTokenCost({ image_url: {
  url: `data:image/${mime};base64,${Buffer.from(bytes).toString("base64")}`, detail: "high" } }, "gpt-4o");

describe("image header parsing at the Token boundary", () => {
  it("rejects zero-length ICNS/JXL/HEIF box inputs disguised as every supported MIME", () => {
    const icns = Buffer.alloc(24); icns.write("icns"); icns.writeUInt32BE(24, 4); icns.write("ic10", 8);
    const jxl = Buffer.from([0,0,0,12,74,88,76,32,13,10,135,10,0,0,0,0,106,120,108,99]);
    const heif = Buffer.alloc(64); heif.writeUInt32BE(24); heif.write("ftypheic", 4);
    heif.write("heicmif1", 16); heif.write("meta", 28); heif.write("ipco", 40);
    for (const mime of ["png", "jpeg", "webp", "gif"]) for (const bytes of [icns, jxl, heif])
      expect(cost(bytes, mime)).toEqual({ tokens:1445, complete:false, reason:"unknown-image-size" });
  });
  it("keeps genuine GIF dimensions and rejects a header/MIME mismatch", () => {
    const gif = Buffer.alloc(13); gif.write("GIF89a"); gif.writeUInt16LE(1024, 6); gif.writeUInt16LE(1024, 8);
    expect(cost(gif, "gif")).toEqual({ tokens:765, complete:true, reason:"image-rule-estimate" });
    expect(cost(gif, "png")).toMatchObject({ complete:false, reason:"unknown-image-size" });
  });
  it("treats truncated, zero-sized and oversized headers as unknown without exposing media bytes", () => {
    const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(13, 8); png.write("IHDR", 12);
    const invalid = [png, png.subarray(0, 7), Buffer.alloc(64*1024, 255), Buffer.alloc(0)];
    for (const bytes of invalid) expect(cost(bytes)).toEqual({ tokens:1445, complete:false, reason:"unknown-image-size" });
  });
});

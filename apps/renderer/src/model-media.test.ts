import { expect, it } from "vitest";
import { decodeModelMedia } from "./model-media";
it("wraps Gemini PCM with the declared rate and retains original little-endian samples", () => {
  const decoded = decodeModelMedia({ mimeType: "audio/L16;codec=pcm;rate=24000", data: btoa(String.fromCharCode(1, 2, 3, 4)) });
  expect(decoded.mimeType).toBe("audio/wav"); expect(new TextDecoder().decode(decoded.bytes.slice(0, 4))).toBe("RIFF");
  expect(new DataView(decoded.bytes.buffer).getUint32(24, true)).toBe(24000); expect([...decoded.bytes.slice(44)]).toEqual([1, 2, 3, 4]);
  const grouped = decodeModelMedia({ mimeType: "audio/pcm;rate=24000", data: "" }, [btoa(String.fromCharCode(1, 2)), btoa(String.fromCharCode(3, 4))]);
  expect([...grouped.bytes.slice(44)]).toEqual([1, 2, 3, 4]); expect(new DataView(grouped.bytes.buffer).getUint32(40, true)).toBe(4);
});
it("converts standard L16 big endian and rejects unknown or malformed raw PCM", () => {
  expect([...decodeModelMedia({ mimeType: "audio/L16;rate=16000", data: btoa(String.fromCharCode(1, 2)) }).bytes.slice(44)]).toEqual([2, 1]);
  for (const media of [{ mimeType: "audio/pcm", data: "AAAA" }, { mimeType: "audio/pcm;rate=24000", data: "AA==" }, { mimeType: "image/png", data: "not base64!" }]) expect(() => decodeModelMedia(media)).toThrow();
});

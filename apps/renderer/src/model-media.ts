import type { ModelResponseState } from "@mycompanion/shared";
type Media = ModelResponseState["media"][number];

export function decodeModelMedia(media: Media, chunks: string[] = [media.data]): { bytes: Uint8Array<ArrayBuffer>; mimeType: string } {
  const decoded = chunks.map(data => Uint8Array.from(atob(data.replace(/\s/g, "")), value => value.charCodeAt(0)));
  const bytes = new Uint8Array(decoded.reduce((size, item) => size + item.length, 0));
  let offset = 0; for (const item of decoded) { bytes.set(item, offset); offset += item.length; }
  const type = media.mimeType.toLowerCase();
  if (!/^audio\/(?:pcm|l16)(?:;|$)/.test(type)) return { bytes, mimeType: media.mimeType };
  const rate = Number(/(?:^|;)\s*rate=(\d+)/.exec(type)?.[1]);
  const channels = Number(/(?:^|;)\s*channels=(\d+)/.exec(type)?.[1] ?? 1);
  if (!Number.isSafeInteger(rate) || rate < 1 || rate > 192000 || !Number.isSafeInteger(channels) || channels < 1 || channels > 8 || bytes.length % (2 * channels)) {
    throw new Error("Unknown or malformed PCM format");
  }
  // Gemini's audio/L16;codec=pcm payloads use signed little-endian PCM. Plain
  // audio/L16 follows network byte order; convert those samples for RIFF/WAVE.
  if (type.startsWith("audio/l16") && !/codec=pcm(?:;|$)/.test(type)) {
    for (let index = 0; index < bytes.length; index += 2) { const first = bytes[index]!; bytes[index] = bytes[index + 1]!; bytes[index + 1] = first; }
  }
  const wav = new Uint8Array(44 + bytes.length), view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) wav[offset + index] = value.charCodeAt(index); };
  text(0, "RIFF"); view.setUint32(4, 36 + bytes.length, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, bytes.length, true); wav.set(bytes, 44);
  return { bytes: wav, mimeType: "audio/wav" };
}

import { Transform, type TransformCallback } from "node:stream";
import { providerHttpError, providerPayloadError } from "./provider-errors.js";

/** Preserve successful SSE frames byte for byte, replacing only provider error envelopes. */
export class ProviderErrorStream extends Transform {
  private pending: Buffer = Buffer.alloc(0);
  private frame: Buffer[] = [];

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try { this.pending = Buffer.concat([this.pending, chunk]); this.consume(false); callback(); }
    catch (error) { callback(error instanceof Error ? error : new Error("无法读取模型流。")); }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.consume(true);
      if (this.pending.length) this.frame.push(this.pending);
      this.emitFrame(); callback();
    } catch (error) { callback(error instanceof Error ? error : new Error("无法读取模型流。")); }
  }

  private consume(final: boolean): void {
    for (;;) {
      const index = this.pending.findIndex(byte => byte === 10 || byte === 13);
      if (index < 0 || (!final && index === this.pending.length - 1 && this.pending[index] === 13)) return;
      const end = index + (this.pending[index] === 13 && this.pending[index + 1] === 10 ? 2 : 1);
      this.frame.push(this.pending.subarray(0, end));
      this.pending = this.pending.subarray(end);
      if (index === 0) this.emitFrame();
    }
  }

  private emitFrame(): void {
    if (!this.frame.length) return;
    const frame = Buffer.concat(this.frame); this.frame = [];
    let event = "", data = "";
    for (const line of frame.toString("utf8").split(/\r\n|\r|\n/)) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      if (field === "data") data += value + "\n";
    }
    let error = event === "error" ? providerHttpError(502) : undefined;
    if (!error) { try { error = providerPayloadError(JSON.parse(data)); } catch { /* A non-JSON successful frame passes through. */ } }
    this.push(error ? `${event === "error" ? "event: error\n" : ""}data: ${JSON.stringify({ error: { message: error.message } })}\n\n` : frame);
  }
}

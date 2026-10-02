import { expect, it, vi } from "vitest";
import { generateRuntimeSource } from "./plugin-runtime-generate.js";

function fixture() {
  const send = vi.fn(), regenerate = vi.fn(), quiet = vi.fn();
  const getContext = () => ({ nativeGenerate: { send, regenerate } });
  const source = generateRuntimeSource.replace(/^import .*;\r?\n/gm, "").replace("export async function", "async function");
  const generate = new Function("getContext", "generateQuietPrompt", "document", source + "\nreturn Generate;")(getContext, quiet, { getElementById: () => ({ value: "" }) });
  return { send, regenerate, quiet, generate };
}

it("passes empty native previews and caller cancellation to the real foreground bridge", async () => {
  const f = fixture(), signal = new AbortController().signal;
  await f.generate("normal", { signal }, true);
  expect(f.send).toHaveBeenCalledWith("", { allowEmpty: true, dryRun: true, signal });
  await f.generate("regenerate", { signal }, true);
  expect(f.regenerate).toHaveBeenCalledWith({ dryRun: true, signal });
});

it("forwards quiet previews and caller signals without using the foreground composer", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  await f.generate("quiet", { signal }, true);
  expect(f.quiet).toHaveBeenCalledWith(expect.objectContaining({dryRun:true,signal}));
  expect(f.send).not.toHaveBeenCalled();
  await f.generate("quiet", { quiet_prompt: "supported request" });
  expect(f.quiet).toHaveBeenCalledWith(expect.objectContaining({ quietPrompt: "supported request" }));
});

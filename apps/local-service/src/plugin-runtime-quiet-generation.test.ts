import { expect, it, vi } from "vitest";
import { quietGenerationSource } from "./plugin-runtime-quiet-generation.js";
import { eventBusSource } from "./plugin-runtime-events.js";

function fixture(quiet = vi.fn(async (_options: { signal: AbortSignal }) => "<think>hidden</think>Reply. trailing")) {
  const EventBus = new Function(eventBusSource + ";return EventBus;")();
  const bus = new EventBus();
  const window = new EventTarget();
  const context = { conversationId: "story", chat: [{}, {}], nativeGenerate: { quiet } };
  const source = quietGenerationSource.replace(/^import .*;\r?\n/gm, "").replace("export async function", "async function");
  const generate = new Function("eventSource", "event_types", "getContext", "window", source + ";return generateQuietPrompt;")(
    bus, { GENERATION_ENDED: "ended", GENERATION_STOPPED: "stopped" }, () => context, window);
  return { bus, quiet, generate };
}

it("reports the chat length without waiting for a hanging completion listener", async () => {
  const f = fixture(), ended = vi.fn(() => new Promise(() => {}));
  f.bus.on("ended", ended);
  await expect(f.generate({ trimToSentence: true })).resolves.toBe("Reply.");
  expect(ended).toHaveBeenCalledWith(2);
  expect(f.bus.events.stopped).toHaveLength(0);
});

it.each(["caller", "event"])("preserves %s cancellation despite a hanging end listener and permits recovery", async mode => {
  const controller = new AbortController();
  const quiet = vi.fn(async (options: { signal: AbortSignal }) => {
    await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    return "unreachable";
  });
  const f = fixture(quiet);
  f.bus.on("ended", () => new Promise(() => {}));
  const pending = f.generate({ signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  if (mode === "caller") controller.abort(); else await f.bus.emit("stopped");
  await rejected;
  expect(f.bus.events.stopped).toHaveLength(0);
  quiet.mockImplementation(async () => "Recovered");
  await expect(f.generate()).resolves.toBe("Recovered");
});

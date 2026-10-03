import { expect, it, vi } from "vitest";
import { readSseStream, waitForGenerationHook } from "./api";

it("stops waiting for a hung listener and observes its later rejection", async () => {
  const controller = new AbortController(); let fail!: (error: Error) => void;
  const operation = new Promise((_resolve, reject) => { fail = reject; });
  const waiting = waitForGenerationHook(operation, controller.signal);
  controller.abort(new Error("stopped"));
  await expect(waiting).rejects.toThrow("stopped");
  fail(new Error("late listener failure")); await Promise.resolve();
});

it("an already cancelled operation cannot report a successful generation hook", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(waitForGenerationHook(Promise.resolve("late"), controller.signal)).rejects.toThrow("cancelled");
});

it("awaits asynchronous event processing before consuming following events", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: bad-json\n\ndata: {"type":"delta"}\n\ndata: {"type":"generation_end"}\n\n'));
    controller.close();
  } });
  const run = readSseStream(body, async event => {
    events.push(event.type);
    if (event.type === "delta") await gate;
  });
  await vi.waitFor(() => expect(events).toEqual(["delta"]));
  release(); await run;
  expect(events).toEqual(["delta", "generation_end"]);
});

it("propagates listener errors and cancels the underlying stream", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"delta"}\n\n'));
  }, cancel });
  await expect(readSseStream(body, async () => { throw new Error("listener failed"); })).rejects.toThrow("listener failed");
  expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
});

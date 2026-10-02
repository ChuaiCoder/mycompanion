import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { eventBusSource } from "./plugin-runtime-events.js";

type Listener = (...args: unknown[]) => unknown;
interface Bus {
  on(name: string, listener: Listener): void;
  once(name: string, listener: Listener): void;
  removeListener(name: string, listener: Listener): void;
  makeFirst(name: string, listener: Listener): void;
  makeLast(name: string, listener: Listener): void;
  emit(name: string, ...args: unknown[]): Promise<void>;
  emitChecked(name: string, ...args: unknown[]): Promise<void>;
  emitAndWait(name: string, ...args: unknown[]): void;
}
function fixture() {
  const error = vi.fn();
  const Constructor = runInNewContext(eventBusSource + "\nEventBus", { console: { error } });
  return { bus: new Constructor(["app_ready"]) as Bus, error };
}

it("awaits ordered listeners, binds the emitter and continues after a rejected listener", async () => {
  const { bus, error } = fixture(), seen: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  bus.on("event", async function(this: Bus, value) {
    expect(this).toBe(bus); expect(value).toBe(7);
    seen.push("start"); await pending; seen.push("finish");
  });
  bus.on("event", () => { throw new Error("script failed"); });
  bus.on("event", () => { seen.push("next"); });
  const emitted = bus.emit("event", 7);
  expect(seen).toEqual(["start"]);
  release(); await emitted;
  expect(seen).toEqual(["start", "finish", "next"]);
  expect(error).toHaveBeenCalledOnce();
});

it("dispatches emitAndWait synchronously over a snapshot without awaiting promises", async () => {
  const { bus } = fixture(), seen: string[] = [];
  const removed = () => { seen.push("removed"); };
  bus.on("event", async () => {
    seen.push("start"); bus.removeListener("event", removed);
    await Promise.resolve(); seen.push("async-end");
  });
  bus.on("event", removed);
  expect(bus.emitAndWait("event")).toBeUndefined();
  expect(seen).toEqual(["start", "removed"]);
  await Promise.resolve();
  expect(seen).toEqual(["start", "removed", "async-end"]);
});

it("replays readiness to late once listeners and preserves first/last ordering", async () => {
  const { bus } = fixture();
  await bus.emit("app_ready", "ready");
  const late = vi.fn(); bus.once("app_ready", late);
  expect(late).toHaveBeenCalledWith("ready");
  await bus.emit("app_ready", "again");
  expect(late).toHaveBeenCalledOnce();
  const seen: number[] = [], first = () => { seen.push(1); }, last = () => { seen.push(3); };
  bus.on("event", last); bus.on("event", () => { seen.push(2); });
  bus.makeFirst("event", first); bus.makeLast("event", last);
  bus.emitAndWait("event");
  expect(seen).toEqual([1, 2, 3]);
});

it("finishes asynchronous once listeners before an awaited emit resolves", async () => {
  const { bus } = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let saved = false;
  const listener = vi.fn(async () => { await pending; saved = true; });
  bus.once("save", listener);
  const emitting = bus.emit("save");
  await bus.emit("save");
  expect(listener).toHaveBeenCalledOnce();
  expect(saved).toBe(false);
  release(); await emitting;
  expect(saved).toBe(true);
});

it("propagates transformation failures in internal request preflight", async () => {
  const { bus } = fixture(), send = vi.fn();
  bus.on("prepare", () => { throw new Error("invalid prompt"); });
  bus.on("prepare", send);
  await expect(bus.emitChecked("prepare")).rejects.toThrow("invalid prompt");
  expect(send).not.toHaveBeenCalled();
});

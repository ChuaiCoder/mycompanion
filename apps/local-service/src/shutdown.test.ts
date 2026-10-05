import { DatabaseSync } from "node:sqlite";
import { connect } from "node:net";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { MemoryRecord } from "@mycompanion/shared";
import { buildApp } from "./app.js";
import * as memory from "./memory/memory-extractor.js";
import { commitCard, fullV2Card, parseSse, sseResponse } from "./testing/helpers.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["", "GET /api/health HTTP/1.1\r\nHost: localhost\r\n"])("closes connections without a complete HTTP request: %j", async prefix => {
  const app = buildApp();
  const origin = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
  const accepted = once(app.server, "connection");
  const socket = connect(Number(origin.port), origin.hostname);
  socket.on("error", () => {});
  let close: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(socket, "connect");
    const [peer] = await accepted;
    if (prefix) {
      const received = once(peer, "data");
      socket.write(prefix);
      await received;
    }
    close = app.close();
    const closed = await Promise.race([
      close.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000); }),
    ]);
    expect(closed, "A socket without a request kept the desktop service alive").toBe(true);
  } finally {
    clearTimeout(timer); socket.destroy(); await (close ?? app.close());
  }
});

it("drains an accepted HTTP response while closing an unused connection", async () => {
  const app = buildApp();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  app.get("/held-response", async () => { entered(); await held; return { saved: true }; });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = fetch(origin + "/held-response").then(async reply => ({ status: reply.status, body: await reply.json() }));
  await started;
  const unused = connect(Number(new URL(origin).port), "127.0.0.1");
  unused.on("error", () => {});
  await once(unused, "connect");
  let finished = false;
  const close = app.close().then(() => { finished = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    release();
    expect(await response).toEqual({ status: 200, body: { saved: true } });
    await close;
  } finally { release(); unused.destroy(); await response; await close; }
});

it("keeps SQLite open until in-flight memory work settles during shutdown", async () => {
  let releaseMemory!: (value: MemoryRecord[]) => void;
  const pendingMemory = new Promise<MemoryRecord[]>(resolve => { releaseMemory = resolve; });
  const extract = vi.spyOn(memory, "extractMemories").mockReturnValue(pendingMemory);
  const closeDatabase = vi.spyOn(DatabaseSync.prototype, "close");
  vi.stubGlobal("fetch", vi.fn(async () => sseResponse(["Reply before shutdown."])));
  const app = buildApp();
  // Registered last, this hook runs before the application's resource hooks.
  let enteredClose!: () => void;
  const closingStarted = new Promise<void>(resolve => { enteredClose = resolve; });
  app.addHook("onClose", async () => { enteredClose(); });
  let close: Promise<void> | undefined;
  try {
    const card = await commitCard(app, fullV2Card);
    await app.inject({ method: "PUT", url: "/api/settings/provider", payload: {
      kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "shutdown-test",
    } });
    const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: card.id } })).json();
    const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/messages`, payload: { content: "Remember this." } });
    expect(parseSse(response.body).at(-1)).toMatchObject({ type: "done", message: { status: "complete" } });
    expect(extract).toHaveBeenCalledOnce();

    // Observe the next event-loop turn while extraction is deliberately pending.
    close = app.close();
    await closingStarted;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closeDatabase).not.toHaveBeenCalled();
    releaseMemory([]);
    await close;
    expect(closeDatabase).toHaveBeenCalledOnce();
  } finally {
    releaseMemory([]);
    await (close ?? app.close());
  }
});

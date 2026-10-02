import { randomInt } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { bindBrowserPort } from "./browser-port.js";

vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: vi.fn((min: number, max: number) => actual.randomInt(min, max)) };
});

describe("desktop browser port binding", () => {
  it("binds a real loopback server and recovers from an occupied first choice", async () => {
    const occupied = Fastify(), service = Fastify();
    try {
      const origin = await bindBrowserPort(port => occupied.listen({ host: "127.0.0.1", port }));
      vi.mocked(randomInt as (min: number, max: number) => number).mockReturnValueOnce(Number(new URL(origin).port));
      const next = await bindBrowserPort(port => service.listen({ host: "127.0.0.1", port }));
      expect(next).not.toBe(origin);
      expect(Number(new URL(next).port)).toBeGreaterThanOrEqual(49152);
      expect(Number(new URL(next).port)).toBeLessThanOrEqual(65535);
      expect((await fetch(next)).status).toBe(404);
    } finally { await service.close(); await occupied.close(); }
  });

  it("retries Windows excluded ports and propagates unrelated startup failures", async () => {
    const denied = Object.assign(new Error("excluded port"), { code: "EACCES" });
    const listen = vi.fn().mockRejectedValueOnce(denied).mockResolvedValue("ready");
    expect(await bindBrowserPort(listen)).toBe("ready"); expect(listen).toHaveBeenCalledTimes(2);
    const fatal = new Error("configuration failure"), broken = vi.fn().mockRejectedValue(fatal);
    await expect(bindBrowserPort(broken)).rejects.toBe(fatal); expect(broken).toHaveBeenCalledTimes(1);
  });

  it("fails after a bounded number of distinct occupied ports", async () => {
    const busy = Object.assign(new Error("busy"), { code: "EADDRINUSE" });
    const listen = vi.fn().mockRejectedValue(busy);
    await expect(bindBrowserPort(listen)).rejects.toMatchObject({ cause: busy });
    expect(listen).toHaveBeenCalledTimes(32);
    expect(new Set(listen.mock.calls.map(([port]) => port)).size).toBe(32);
  });
});

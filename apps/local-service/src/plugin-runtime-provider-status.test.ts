import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { providerStatusSource } from "./plugin-runtime-provider-status.js";

it("discards observations from a superseded connection but preserves no-op settings flushes", () => {
  const window = new EventTarget();
  const source = providerStatusSource.replace(/^import .*;$/gm, "").replace(/export /g, "");
  const status = runInNewContext(source + "\n({getProviderRevision,markProviderConnected,read:()=>({online_status,connectedToApi})})", {
    window, eventSource: { emit: async () => {} }, event_types: { ONLINE_STATUS_CHANGED: "online" },
  });
  const old = status.getProviderRevision();
  window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: {} }));
  status.markProviderConnected("old", old);
  expect(status.read().connectedToApi).toBe(false);
  const current = status.getProviderRevision();
  window.dispatchEvent(new CustomEvent("mycompanion:provider-saved", { detail: { connectionUnchanged: true } }));
  status.markProviderConnected("current", current);
  expect(status.read()).toEqual({ online_status: "current", connectedToApi: true });
});

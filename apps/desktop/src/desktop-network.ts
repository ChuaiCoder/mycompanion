import type { Session } from "electron";

const mirrors = ["fastly.jsdelivr.net", "cdn.jsdelivr.net", "testingcf.jsdelivr.net"];
const retryStatuses = new Set([502, 503, 504]);
const installed = new WeakSet<Session>();
type NetworkOptions = {
  /** Test transport injection; production uses the same Chromium session. */
  fetcher?: (request: Request) => Promise<Response>;
  onAttempt?: (url: string, error?: string) => void;
};

function publicAsset(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "GET" && url.protocol === "https:" && !url.port
    && mirrors.includes(url.hostname) && /^\/(?:npm|gh)\//.test(url.pathname)
    && !url.username && !url.password && !url.search
    && !request.headers.has("authorization") && !request.headers.has("range")
    && request.mode !== "navigate" && request.mode !== "same-origin";
}

/** Handle HTTPS using Electron's documented native fetch forwarding path.
 * Only public jsDelivr assets have retries. Responses/headers are not rewritten;
 * the renderer keeps Chromium CORS, CSP, cookies and integrity enforcement.
 * Protocol handling covers top-level, srcdoc, Blob and worker requests alike.
 */
export function installDesktopNetwork(session: Session, options: NetworkOptions = {}): void {
  if (installed.has(session)) return;
  const fetcher = options.fetcher ?? (request => session.fetch(request, { bypassCustomProtocolHandlers: true }));
  const preferred = new Map<string, string>();
  session.protocol.handle("https", async request => {
    if (!publicAsset(request)) return fetcher(request);
    const original = new URL(request.url);
    const hosts = [...new Set([preferred.get(original.hostname), original.hostname, ...mirrors].filter((host): host is string => Boolean(host)))];
    let lastError: unknown;
    let lastResponse: Response | undefined;
    for (const hostname of hosts) {
      if (request.signal.aborted) throw request.signal.reason;
      const url = new URL(original); url.hostname = hostname;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("CDN request timed out", "TimeoutError")), 8000);
      try {
        const attempt = new Request(new Request(url, request), { signal: AbortSignal.any([request.signal, controller.signal]) });
        options.onAttempt?.(url.href);
        const response = await fetcher(attempt);
        if (retryStatuses.has(response.status)) {
          void lastResponse?.body?.cancel().catch(() => {});
          lastResponse = response;
          continue;
        }
        void lastResponse?.body?.cancel().catch(() => {});
        preferred.set(original.hostname, hostname);
        return response;
      } catch (error) {
        if (request.signal.aborted) throw error;
        lastError = error;
        options.onAttempt?.(url.href, String(error));
        console.warn("[MyCompanion CDN] request failed", url.href, String(error));
      } finally { clearTimeout(timer); }
    }
    if (lastResponse) return lastResponse;
    throw lastError ?? new TypeError("All jsDelivr endpoints failed");
  });
  installed.add(session);
}

import type { ProviderSettings } from "@mycompanion/shared";

/** Credentials belong to one protocol and effective transport base path. */
export function sameProviderCredentialScope(left: Pick<ProviderSettings, "kind" | "baseUrl">,
  right: Pick<ProviderSettings, "kind" | "baseUrl">): boolean {
  if (left.kind !== right.kind) return false;
  const endpoint = (value: string): string => {
    const url = new URL(value);
    // Completion transport discards query/fragment and normalizes a trailing slash.
    url.search = ""; url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.href;
  };
  try { return endpoint(left.baseUrl) === endpoint(right.baseUrl); }
  catch { return false; }
}

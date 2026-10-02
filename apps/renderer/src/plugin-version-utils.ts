import type { CodePluginUpdateCheck } from "@mycompanion/shared";

/** Resolve stored legacy HEAD/short names with the same precedence as the service. */
export function resolvePluginRef(checked: Pick<CodePluginUpdateCheck, "refs" | "defaultRef">, ref: string) {
  return checked.refs.find(item => item.ref === ref)
    ?? (ref === "HEAD" ? checked.refs.find(item => item.ref === checked.defaultRef)
      : !ref.startsWith("refs/") ? checked.refs.find(item => item.ref === "refs/heads/" + ref)
        ?? checked.refs.find(item => item.ref === "refs/tags/" + ref) : undefined);
}

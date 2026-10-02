// A saved connection (including a replacement key with the same model/URL)
// invalidates outstanding observations. The extension bridge explicitly marks
// its unchanged settings flushes so ordinary prompt preparation is not a reset.
let revision = 0;
window.addEventListener("mycompanion:provider-saved", event => {
  if (!(event as CustomEvent<{ connectionUnchanged?: boolean }>).detail?.connectionUnchanged) revision++;
});

export function observeProviderConnection(): () => boolean {
  const started = revision;
  return () => started === revision;
}

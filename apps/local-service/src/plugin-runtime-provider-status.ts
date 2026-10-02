// Browser-visible provider status is based on observed successful requests,
// not merely a saved URL or model name.
export const providerStatusSource = String.raw`
import { eventSource, event_types } from '/plugin-runtime/compat-runtime.js';
export let online_status = 'no_connection';
export let connectedToApi = false;
let revision = 0;
export const getProviderRevision = () => revision;
function publish(value) {
  const next = typeof value === 'string' && value.trim() ? value.trim() : 'connected';
  if (online_status === next && connectedToApi) return;
  online_status = next; connectedToApi = true;
  void eventSource.emit(event_types.ONLINE_STATUS_CHANGED, online_status);
}
export function markProviderConnected(model, observedRevision = revision) {
  if (observedRevision === revision) publish(model);
}
export function markProviderDisconnected() {
  if (!connectedToApi && online_status === 'no_connection') return;
  online_status = 'no_connection'; connectedToApi = false;
  void eventSource.emit(event_types.ONLINE_STATUS_CHANGED, online_status);
}
window.addEventListener('mycompanion:provider-tested', event => {
  if (event.detail?.ok) markProviderConnected(event.detail.model);
  else markProviderDisconnected();
});
window.addEventListener('mycompanion:provider-saved', event => {
  if (event.detail?.connectionUnchanged) return;
  revision++;
  markProviderDisconnected();
});
`;

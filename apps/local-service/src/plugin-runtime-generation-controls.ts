// UI and cancellation bridge only. Model generation APIs remain separate.
export const generationControlsSource = String.raw`
import { getContext, subscribeHostContext, eventSource, event_types } from '/plugin-runtime/compat-runtime.js';
import { emitNativeGenerationStopped,takeSlashGenerationStopOrigin } from '/plugin-runtime/slash-adapter.js';
let controls;
let busy = Boolean(getContext().generationControlsBusy);
let dryRun = false;
eventSource.on(event_types.GENERATION_STARTED, (_type, options = {}, preview = false) => { dryRun = Boolean(preview || options.dryRun); });
export let is_send_press = Boolean(getContext().nativeGenerating);
export function connectGenerationControls(value) { controls = value; }
function connected() { if (!controls) throw new Error('生成控件尚未连接。'); return controls; }
subscribeHostContext(context => {
  is_send_press = Boolean(context.nativeGenerating);
  const ended = busy && !context.generationControlsBusy;
  busy = Boolean(context.generationControlsBusy);
  if (busy) document.body.dataset.generating = 'true';
  else delete document.body.dataset.generating;
  // Tavern's dryRun returns before showStopButton/hideStopButton. Releasing
  // preview UI controls must not consume one-generation script injections.
  if (ended && !dryRun) void eventSource.emit(event_types.GENERATION_ENDED, context.chat.length).catch(error => connected().error(error));
});
export function activateSendButtons() { connected().busy(false); }
export function deactivateSendButtons() { connected().busy(true); }
// Tavern uses this name to release generation and refresh its controls. The
// independent UI owns the current message's regenerate action through React.
export function showSwipeButtons() { activateSendButtons(); }
export function setGenerationProgress(progress) {
  const input = document.getElementById('send_textarea');
  if (!input) return;
  const value = Number(progress);
  input.style.background = value && Number.isFinite(value) ? 'linear-gradient(90deg, #008000d6 ' + value + '%, transparent ' + value + '%)' : '';
  input.style.transition = value && Number.isFinite(value) ? '0.25s ease-in-out' : '';
}
export function stopGeneration() {
  const origin = takeSlashGenerationStopOrigin();
  const stopped = connected().stop();
  void emitNativeGenerationStopped(origin).catch(error => connected().error(error));
  return stopped;
}
`;

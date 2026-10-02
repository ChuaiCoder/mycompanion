// Native chat/renderer and lifecycle integration for the reused ST execution core.
export const slashAdapterSource = String.raw`
import { getContext,subscribeHostContext,eventSource,event_types } from '/plugin-runtime/compat-runtime.js';
import { messageFormatting,addOneMessage } from '/plugin-runtime/message-rendering.js';
import { saveChatConditional } from '/plugin-runtime/chat.js';
import { power_user } from '/scripts/power-user.js';
const activeExecutions = new Set();
let contextKey = JSON.stringify([getContext().conversationId,getContext().branchId]);
let acceptedGenerationBranch;
window.addEventListener('mycompanion:generation-branch-accepted', event => {
  const {conversationId,branchId} = event.detail ?? {};
  if (conversationId !== getContext().conversationId || typeof branchId !== 'string') return;
  acceptedGenerationBranch = {from:contextKey,to:JSON.stringify([conversationId,branchId])};
});
export function ensureSlashDefaults() {
  power_user.stscript ??= {};
  power_user.stscript.parser ??= {};
  power_user.stscript.parser.flags ??= {};
}
export function trackSlashExecution(controller) {
  activeExecutions.add(controller);
  return () => activeExecutions.delete(controller);
}
export function abortSlashExecutions(reason = 'Command execution stopped') {
  for (const controller of activeExecutions) if (!controller.signal.aborted) controller.abort(reason, true);
}
subscribeHostContext(context => {
  const next = JSON.stringify([context.conversationId,context.branchId]);
  if (next !== contextKey) {
    const accepted = acceptedGenerationBranch?.from === contextKey && acceptedGenerationBranch?.to === next;
    acceptedGenerationBranch = undefined; contextKey = next;
    if (!accepted) abortSlashExecutions('Story or branch changed');
  }
});
eventSource.on(event_types.GENERATION_STOPPED, () => abortSlashExecutions());
window.addEventListener('pagehide', () => abortSlashExecutions('Window closed'));
export function abortableSlashDelay(amount, controller) {
  if (controller?.signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); controller?.removeEventListener('abort', finish); resolve(); };
    controller?.addEventListener('abort', finish);
    timer = setTimeout(finish, amount);
    if (controller?.signal.aborted) finish();
  });
}
export function waitForSlashContinue(controller) {
  if (!controller?.signal.paused || controller.signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      if (controller.signal.paused && !controller.signal.aborted) return;
      controller.removeEventListener('continue', finish); controller.removeEventListener('abort', finish); resolve();
    };
    controller.addEventListener('continue', finish); controller.addEventListener('abort', finish); finish();
  });
}
export const slashMarkdown = value => messageFormatting(String(value ?? ''), '', true, false, -1);
export function sendSystemMessage(type, value) {
  const context = getContext();
  if (!context.conversationId) throw new Error('Open a story before sending a system message');
  const message = {name:'System',is_system:true,is_user:false,mes:String(value ?? ''),send_date:new Date().toISOString(),extra:{type}};
  context.chat.push(message); addOneMessage(message); void saveChatConditional();
}
`;

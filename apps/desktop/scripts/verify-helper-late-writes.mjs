// Observe the original Helper's unbound current-scope async updater. This is a
// negative compatibility audit, not a substitute for iframe teardown tests.
import assert from 'node:assert/strict';
import { toExtensionChatState } from '@mycompanion/shared';

export async function verifyHelperLateWrites({ getWindow, getService, waitFor, conversationId, characterId, restart }) {
  const report = { passed: false, auditCompleted: false, completeE03: false, stages: [],
    scope: 'Original top-window updateVariablesWith(chat), actual story selection, HTTP/SQLite and full new-port restart',
    boundary: 'A top-window unbound current selector is separate from a destroyed story script iframe; no generic JS cancellation is inferred.' };
  const evaluate = async source => {
    const result = await getWindow().webContents.executeJavaScript(`(async()=>{try{
      const helper=window.TavernHelper,core=await import('/script.js'),host=await import('/plugin-runtime/desktop-host.js');
      ${source}
    }catch(error){return {__lateError:error.stack||String(error)};}})()`);
    if (result?.__lateError) throw new Error(result.__lateError);
    return result;
  };
  const stage = (name, evidence) => { report.stages.push({ name, evidence }); console.log('Observed: ' + name); };
  const stored = async id => {
    const response = await getService().inject({ url: '/api/conversations/' + id });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().chatMetadata.variables ?? {};
  };
  const select = async id => {
    await evaluate(`const nav=[...document.querySelectorAll('nav button')].find(button=>button.textContent.includes('故事'));nav?.click();`);
    await waitFor(() => evaluate(`return !!document.querySelector('button[data-conversation-id="${id}"]');`));
    await evaluate(`document.querySelector('button[data-conversation-id="${id}"]').click();`);
    await waitFor(() => evaluate(`return core.getCurrentChatId()===${JSON.stringify(id)};`));
  };
  try {
    const initial = (await getService().inject({ url: '/api/conversations/' + conversationId })).json();
    const created = await getService().inject({ method: 'POST', url: '/api/conversations', payload: { characterId: characterId ?? initial.characterId, title: 'Late updater audit B' } });
    assert.equal(created.statusCode, 201, created.body);
    const second = created.json(), base = toExtensionChatState(second), next = structuredClone(base);
    next.metadata.variables = { __lateScopeOwner: 'B', __lateFreshB: true };
    const saved = await getService().inject({ method: 'PUT', url: '/api/conversations/' + second.id + '/extension-state', payload: { branchId: second.activeBranchId, base, next } });
    assert.equal(saved.statusCode, 200, saved.body);
    report.storyIds = { a: conversationId, b: second.id };
    await restart(conversationId);
    await evaluate(`helper.insertOrAssignVariables({__lateScopeOwner:'A'},{type:'chat'});await host.flush();
      window.__lateUpdaterPromise=helper.updateVariablesWith(variables=>new Promise(resolve=>{
        window.__lateRead=variables;window.__lateResolve=()=>resolve({...variables,__lateCompleted:true});
      }),{type:'chat'});`);
    assert.equal((await stored(conversationId)).__lateScopeOwner, 'A');
    stage('original-updater-reads-A-before-pending-promise', await evaluate(`return {readOwner:window.__lateRead.__lateScopeOwner,current:core.getCurrentChatId()};`));
    await select(second.id);
    const before = await evaluate(`return {current:core.getCurrentChatId(),variables:helper.getVariables({type:'chat'})};`);
    assert.equal(before.variables.__lateScopeOwner, 'B'); assert.equal(before.variables.__lateFreshB, true);
    stage('actual-story-UI-switches-to-B-before-old-top-updater-finishes', before);
    await evaluate(`window.__lateResolve();await window.__lateUpdaterPromise;await host.flush();`);
    const after = { a: await stored(conversationId), b: await stored(second.id) };
    report.lateWriteObserved = after.b.__lateScopeOwner === 'A' && after.b.__lateCompleted === true && after.b.__lateFreshB === undefined;
    stage('late-original-replaceVariables-resolves-its-current-selector-at-write-time', after);
    const ports = await restart(second.id);
    const restarted = { a: await stored(conversationId), b: await stored(second.id), ports };
    assert.deepEqual(restarted.b, after.b); assert.deepEqual(restarted.a, after.a);
    stage('full-window-and-service-restart-retains-the-observed-SQLite-tables', restarted);
    report.auditCompleted = true;
    report.passed = !report.lateWriteObserved;
    if (report.lateWriteObserved) report.remaining = 'The unchanged original top-window async updater can replace story B with data read from A. Host save queues bind at save invocation and cannot infer the old read owner from a result and {type:chat}. No silent Helper patch or variable-name origin inference was applied.';
  } catch (error) { report.error = error.stack || String(error); }
  return report;
}

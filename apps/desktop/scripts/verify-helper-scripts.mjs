// Owned script fixtures executed by the unmodified Helper's actual iframe
// runtime. They are test inputs, not bundled third-party extension code.
import assert from 'node:assert/strict';

const id = 'mc-lifecycle-script';
const source = version => `
const script = {type:'script'};
const saved = getVariables(script);
insertOrAssignVariables({boots:(saved.boots || 0) + 1, version:${JSON.stringify(version)}}, script);
eventOn('mc-script-probe', value => {
  const data = getVariables(script);
  insertOrAssignVariables({ticks:(data.ticks || 0) + 1, last:value}, script);
});
eventOn('mc-script-generate', async () => {
  const reply = await generate({user_input:'脚本调用生成',should_stream:false});
  insertOrAssignVariables({reply}, script);
});
eventEmitAndWait('mc-script-probe', ${JSON.stringify(version)});
const immediate = getVariables(script).last;
if (getLastMessageId() < 0) await new Promise(resolve => {
  const listener = eventOn(tavern_events.CHAT_CHANGED, () => {
    if (getLastMessageId() >= 0) { listener.stop(); resolve(); }
  });
});
await triggerSlash('/setvar key=mcScriptSlash ${version}');
window.__mcScriptReady = {id:getScriptId(),version:${JSON.stringify(version)},immediate};
`;
const scriptState = `(() => {
  const tree = TavernHelper.getScriptTrees({type:'global'}).find(script => script.id === ${JSON.stringify(id)});
  const frame = [...document.querySelectorAll('iframe')].find(frame => frame.id.endsWith('--' + ${JSON.stringify(id)}));
  return {data:tree?.data,enabled:tree?.enabled,frame:!!frame,ready:frame?.contentWindow?.__mcScriptReady,
    slash:TavernHelper.getVariables({type:'chat'}).mcScriptSlash};
})()`;

async function ready(window, waitFor, version, boots) {
  return waitFor(async () => {
    const state = await window.webContents.executeJavaScript(scriptState);
    return state.ready?.version === version && state.data?.boots === boots ? state : null;
  }, 35_000);
}
async function flush(window) {
  await window.webContents.executeJavaScript(`import('/plugin-runtime/desktop-host.js').then(host => host.flush())`);
}

export async function verifyHelperScriptsBeforeReload(window, waitFor, expectedReply = '原版助手回复') {
  const initial = {type:'script',id,name:'Lifecycle fixture',enabled:true,content:source('v1')};
  await window.webContents.executeJavaScript(`TavernHelper.replaceScriptTrees([${JSON.stringify(initial)}],{type:'global'})`);
  const started = await ready(window, waitFor, 'v1', 1);
  assert.equal(started.ready.id, id);
  assert.equal(started.ready.immediate, 'v1', 'Helper eventEmitAndWait must invoke the listener before returning');
  assert.equal(started.data.ticks, 1);
  assert.equal(started.slash, 'v1');
  await window.webContents.executeJavaScript(`import('/script.js').then(core => core.eventSource.emit('mc-script-generate'))`);
  const generated = await window.webContents.executeJavaScript(scriptState);
  assert.equal(generated.data.reply, expectedReply, 'The real script iframe did not complete generation');

  await window.webContents.executeJavaScript(`TavernHelper.updateScriptTreesWith(scripts => scripts.map(script => ({...script,enabled:false})),{type:'global'})`);
  await waitFor(async () => !(await window.webContents.executeJavaScript(scriptState)).frame);
  await window.webContents.executeJavaScript(`import('/script.js').then(core => core.eventSource.emit('mc-script-probe','disabled'))`);
  const disabled = await window.webContents.executeJavaScript(scriptState);
  assert.equal(disabled.data.ticks, generated.data.ticks, 'A disabled script retained its event listener');
  await window.webContents.executeJavaScript(`TavernHelper.updateScriptTreesWith(scripts => scripts.map(script => ({...script,enabled:true})),{type:'global'})`);
  const reenabled = await ready(window, waitFor, 'v1', 2);
  assert.equal(reenabled.data.ticks, 2);
  await window.webContents.executeJavaScript(`import('/script.js').then(core => core.eventSource.emit('mc-script-probe','one-listener'))`);
  const probe = await window.webContents.executeJavaScript(scriptState);
  assert.equal(probe.data.ticks, 3, 'Re-enabling a script duplicated event listeners');
  await window.webContents.executeJavaScript(`TavernHelper.updateScriptTreesWith(scripts => scripts.map(script => ({...script,content:${JSON.stringify(source('v2'))}})),{type:'global'})`);
  const updated = await ready(window, waitFor, 'v2', 3);
  assert.equal(updated.data.ticks, 4);
  assert.equal(updated.slash, 'v2');
  assert.equal(updated.data.reply, expectedReply);
  await flush(window);
  const persisted = await window.webContents.executeJavaScript(`fetch('/api/extensions/settings').then(response=>response.json())`);
  assert.deepEqual(persisted.extensionSettings.tavern_helper.script.scripts[0].data, updated.data);
  return {passed:true,started,generated,disabled,reenabled,updated};
}

export async function verifyHelperScriptsAfterReload(window, waitFor, boots, ticks, expectedReply = '原版助手回复') {
  const state = await ready(window, waitFor, 'v2', boots);
  assert.equal(state.data.ticks, ticks);
  assert.equal(state.data.reply, expectedReply);
  assert.equal(state.slash, 'v2');
  await flush(window);
  return {passed:true,...state};
}

// Project-owned fixtures executed by the byte-unchanged Helper, using its
// public script/variable APIs and the real host character/preset selectors.
import assert from 'node:assert/strict';
export const scopePresetNames = ['MC scope A', 'MC scope B'];
export async function seedHelperScopes(service, first, card) {
  const secondCard=structuredClone(card);secondCard.data.name='Scope other';
  const second=await service.inject({method:'POST',url:'/api/characters/import/commit',payload:{filename:'scope-other.json',card:secondCard}});
  assert.equal(second.statusCode,201,second.body);
  const fixture={characters:[first,second.json()].map(value=>({id:value.id,avatar:value.avatar||value.id+'.png'}))};
  const previous=(await service.inject({method:'GET',url:'/api/extensions/settings'})).json().extensionSettings;
  const saved=await service.inject({method:'PUT',url:'/api/extensions/settings',payload:{extensionSettings:{...previous,tavern_helper:{script:{enabled:{
    global:true,characters:fixture.characters.map(value=>value.avatar),presets:scopePresetNames},
    popuped:{characters:fixture.characters.map(value=>value.avatar),presets:scopePresetNames}}}}}});
  assert.equal(saved.statusCode,200,saved.body);
  for (const name of scopePresetNames) {
    const preset=await service.inject({method:'POST',url:'/api/presets/save',payload:{apiId:'openai',name,preset:{extensions:{}}}});
    assert.equal(preset.statusCode,200,preset.body);
  }
  return fixture;
}
const execute = (window, source) => window.webContents.executeJavaScript(source);
const scriptId = (scope, owner) => 'mc-scope-' + scope + '-' + owner;
function script(scope, owner) {
  return { type:'script', id:scriptId(scope, owner), name:scope + ' ' + owner, enabled:true,
    content:`
const initial = getVariables({type:'script'});
insertOrAssignVariables({boots:(initial.boots || 0) + 1,owner:${JSON.stringify(owner)}},{type:'script'});
eventOn('mc-scope-probe', value => {
  const state=getVariables({type:'script'});
  insertOrAssignVariables({ticks:(state.ticks || 0) + 1,last:value},{type:'script'});
});
window.__mcScopeReady={scope:${JSON.stringify(scope)},owner:${JSON.stringify(owner)},variables:getVariables({type:${JSON.stringify(scope)}})};
` };
}
async function state(window, scope) {
  return execute(window, `(() => ({variables:TavernHelper.getVariables({type:${JSON.stringify(scope)}}),
    scripts:TavernHelper.getScriptTrees({type:${JSON.stringify(scope)}}),
    frames:[...document.querySelectorAll('iframe')].filter(frame=>frame.id.includes('mc-scope-${scope}-'))
      .map(frame=>({id:frame.id,ready:frame.contentWindow?.__mcScopeReady}))}))()`);
}
async function ready(window, waitFor, scope, owner) {
  return waitFor(async () => {
    const value = await state(window, scope);
    return value.variables.owner === owner && value.frames.length === 1 && value.frames[0].ready?.owner === owner ? value : null;
  }, 12_000).catch(async error => {
    const detail=await execute(window, `import('/script.js').then(async core=>{
      const manager=(await import('/scripts/preset-manager.js')).getPresetManager('openai');
      const settings=(await import('/scripts/openai.js')).oai_settings;
      const saved=await fetch('/api/extensions/settings').then(response=>response.json());
      return {selected:core.this_chid,avatar:core.characters[core.this_chid]?.avatar,
        enabled:(await import('/scripts/extensions.js')).extension_settings.tavern_helper?.script?.enabled,
        preset:manager.getSelectedPresetName(),liveExtensions:settings.extensions,
        selectLength:manager.select.length,selectHtml:manager.select[0]?.outerHTML,names:manager.getPresetList().preset_names,
        storedPreset:manager.getCompletionPresetByName(manager.getSelectedPresetName()),
        savedOpenAI:saved.extensionSettings?.__mycompanion_openai?.settings};
    })`);
    throw new Error(error.message+' '+JSON.stringify({scope,owner,state:await state(window,scope),detail}));
  });
}
async function selectCharacter(window, id) {
  await execute(window, `import('/script.js').then(async core => {
    await core.getCharacters(); await core.selectCharacterById(core.characters.findIndex(character=>character.id===${JSON.stringify(id)}));
  })`);
}
async function selectPreset(window, name) {
  await execute(window, `import('/scripts/preset-manager.js').then(({getPresetManager})=>{
    const manager=getPresetManager('openai');return manager.selectPreset(manager.findPreset(${JSON.stringify(name)}));
  })`);
}
async function install(window, scope, owner) {
  await execute(window, `(() => {
    TavernHelper.insertOrAssignVariables({owner:${JSON.stringify(owner)}},{type:${JSON.stringify(scope)}});
    TavernHelper.replaceScriptTrees([${JSON.stringify(script(scope,owner))}],{type:${JSON.stringify(scope)}});
  })()`);
}
async function stored(window, scope, identity) {
  return execute(window, `(async()=>{
    if(${JSON.stringify(scope)}==='character') {
      const result=await fetch('/api/characters/get',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({avatar_url:${JSON.stringify(identity)}})});
      if(!result.ok)throw new Error(await result.text());return (await result.json()).data.extensions.tavern_helper;
    }
    const result=await fetch('/api/presets/openai').then(response=>response.json());
    return result.entries.find(entry=>entry.name===${JSON.stringify(identity)})?.preset.extensions?.tavern_helper;
  })()`);
}
async function persist(window, waitFor, scope, identity, owner) {
  return waitFor(async () => {
    const saved=await stored(window,scope,identity);
    return saved?.variables?.owner===owner && saved.scripts?.[0]?.data?.boots ? saved : null;
  });
}
async function probe(window, value) {
  await execute(window, `import('/script.js').then(core=>core.eventSource.emit('mc-scope-probe',${JSON.stringify(value)}))`);
}

export async function verifyHelperScopesBeforeReload(window, waitFor, fixture, report = { passed:false, stages:[] }) {
  const [a,b] = fixture.characters;
  await execute(window, `import('/scripts/preset-manager.js').then(async({getPresetManager})=>{
    const manager=getPresetManager('openai');
    for(const name of ${JSON.stringify(scopePresetNames)})await manager.savePreset(name,{...manager.getPresetSettings(),extensions:{}});
  })`);
  await selectPreset(window,scopePresetNames[0]);
  await install(window,'character','A');
  await ready(window,waitFor,'character','A');
  await persist(window,waitFor,'character',a.avatar,'A');
  await probe(window,'character-A');
  await selectCharacter(window,b.id);
  await install(window,'character','B');
  await ready(window,waitFor,'character','B');
  await probe(window,'character-B');
  await persist(window,waitFor,'character',b.avatar,'B');
  await selectCharacter(window,a.id);
  report.character = await ready(window,waitFor,'character','A');
  assert.equal(report.character.scripts[0].data.boots,2);
  assert.equal(report.character.scripts[0].data.ticks,1);
  assert.equal(report.character.scripts[0].data.last,'character-A');
  report.stages.push('character-script-switch-releases-old-frame-and-listener-preserves-own-variables');

  await install(window,'preset','A');
  await ready(window,waitFor,'preset','A');
  await persist(window,waitFor,'preset',scopePresetNames[0],'A');
  await probe(window,'preset-A');
  await selectPreset(window,scopePresetNames[1]);
  await install(window,'preset','B');
  await ready(window,waitFor,'preset','B');
  await probe(window,'preset-B');
  await persist(window,waitFor,'preset',scopePresetNames[1],'B');
  await selectPreset(window,scopePresetNames[0]);
  report.preset = await ready(window,waitFor,'preset','A');
  assert.equal(report.preset.scripts[0].data.boots,2);
  assert.equal(report.preset.scripts[0].data.ticks,1);
  assert.equal(report.preset.scripts[0].data.last,'preset-A');
  report.stages.push('preset-script-switch-releases-old-frame-and-listener-preserves-own-variables');

  await execute(window, `TavernHelper.insertOrAssignVariables({pending:'belongs-to-A'},{type:'preset'})`);
  await selectPreset(window,scopePresetNames[1]);
  await ready(window,waitFor,'preset','B');
  await execute(window, `TavernHelper.insertOrAssignVariables({pending:'belongs-to-B'},{type:'preset'})`);
  await waitFor(async()=> (await stored(window,'preset',scopePresetNames[1]))?.variables?.pending==='belongs-to-B');
  report.pendingA = await stored(window,'preset',scopePresetNames[0]);
  assert.equal(report.pendingA.variables.pending,'belongs-to-A','A pending preset write was lost when B changed before the Helper debounce');
  await selectPreset(window,scopePresetNames[0]);
  await ready(window,waitFor,'preset','A');
  report.stages.push('preset-delayed-write-remains-with-origin-after-fast-switch');
  await execute(window, `import('/plugin-runtime/desktop-host.js').then(host=>host.flush())`);
  await persist(window,waitFor,'preset',scopePresetNames[0],'A');
  report.passed=true;
  return report;
}

export async function verifyHelperScopesAfterReload(window, waitFor) {
  const character = await ready(window,waitFor,'character','A');
  const preset = await ready(window,waitFor,'preset','A');
  assert.equal(preset.variables.pending,'belongs-to-A');
  assert(character.scripts[0].data.boots>=3);
  assert(preset.scripts[0].data.boots>=4,JSON.stringify(preset));
  return {passed:true,character,preset};
}

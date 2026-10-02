import assert from 'node:assert/strict';

// Project-authored cards/variables, exercised only through the unchanged Helper.
export async function verifyHelperMacroLifecycle(window,providerBodies,expectedReply){
  const beforeRequests=providerBodies.length;
  const result=await window.webContents.executeJavaScript(`(async()=>{
    const core=await import('/script.js'),world=await import('/scripts/world-info.js'),power=await import('/scripts/power-user.js');
    const vars=await import('/scripts/variables.js'),host=await import('/plugin-runtime/desktop-host.js');
    const previous={engine:power.power_user.experimental_macro_engine,worlds:[...world.selected_world_info]};
    const name='mc-original-helper-macros',runs=[];
    try{
      await world.saveWorldInfo(name,{entries:{1:{...world.newWorldInfoEntryTemplate,uid:1,key:[],constant:true,position:1,content:'ORIGINAL_HELPER_WORLD={{incvar::helperWorld}}/{{incglobalvar::helperGlobal}}'}}},true);
      world.selected_world_info.splice(0,world.selected_world_info.length,name);
      for(const experimental of [false,true]){
        power.power_user.experimental_macro_engine=experimental;
        vars.setLocalVariable('helperWorld',0);vars.setGlobalVariable('helperGlobal',0);await host.flush();
        for(const stream of [false,true]){
          const reply=await TavernHelper.generate({user_input:'Check world macro state',should_stream:stream});
          runs.push({experimental,stream,reply,local:vars.getLocalVariable('helperWorld'),global:vars.getGlobalVariable('helperGlobal')});
        }
        await host.flush();
        const saved=await fetch('/api/conversations/'+core.getCurrentChatId()).then(response=>response.json());
        runs.at(-1).persisted=saved.chatMetadata.variables.helperWorld;
      }
      return runs;
    }finally{
      power.power_user.experimental_macro_engine=previous.engine;world.selected_world_info.splice(0,world.selected_world_info.length,...previous.worlds);
      vars.deleteLocalVariable('helperWorld');vars.deleteGlobalVariable('helperGlobal');
      await world.updateWorldInfoList();await world.deleteWorldInfo(name);await host.flush();
    }
  })()`);
  assert.equal(providerBodies.length-beforeRequests,4);
  for(const [index,run] of result.entries()){
    const expected=index%2+1;
    assert.equal(run.reply,expectedReply);assert.equal(run.local,expected);assert.equal(run.global,expected);
    if(run.stream)assert.equal(run.persisted,2);
    assert(JSON.stringify(providerBodies[beforeRequests+index].messages).includes('ORIGINAL_HELPER_WORLD='+expected+'/'+expected));
  }
  return {passed:true,runs:result,stages:['original-helper-legacy-and-experimental-world-macros-commit-once','original-helper-stream-and-nonstream-read-and-persist-current-macro-state']};
}

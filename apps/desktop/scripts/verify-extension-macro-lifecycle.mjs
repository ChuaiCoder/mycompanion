import assert from 'node:assert/strict';
import {createServer} from 'node:http';

export async function verifyExtensionMacroLifecycle(window,service){
  const bodies=[],provider=(await service.inject({method:'GET',url:'/api/settings/provider'})).json();
  const model=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;bodies.push(JSON.parse(raw));
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:'Macro API reply'}}]}));
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const evaluate=source=>window.webContents.executeJavaScript(source);
  try{
    await service.inject({method:'PUT',url:'/api/settings/provider',payload:{kind:'ollama',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'gpt-4o',maxTokens:128,contextLimitTokens:8192}});
    const result=await evaluate(`(async()=>{
      const core=await import('/script.js'),world=await import('/scripts/world-info.js'),openai=await import('/scripts/openai.js');
      const vars=await import('/scripts/variables.js'),power=await import('/scripts/power-user.js'),host=await import('/plugin-runtime/desktop-host.js');
      await (await import('/plugin-runtime/openai-settings.js')).refreshOpenAISettings();
      const before={engine:power.power_user.experimental_macro_engine,persona:power.power_user.persona_description,position:power.power_user.persona_description_position,worlds:[...world.selected_world_info]};
      const originalFetch=window.fetch,name='mc-api-macro-lifecycle',results=[];
      const originalCharacter=core.characters[core.this_chid].id,originalStory=core.getCurrentChatId();
      const created=await originalFetch('/api/characters/create',{method:'POST',headers:core.getRequestHeaders(),body:JSON.stringify({ch_name:'Macro response navigation',first_mes:'Other story'})});
      if(!created.ok)throw new Error(await created.text());
      const otherAvatar=await created.text();await core.getCharacters();
      const selectOriginal=async()=>{await core.selectCharacterById(core.characters.findIndex(item=>item.id===originalCharacter));if(core.getCurrentChatId()!==originalStory)throw new Error('Original macro story was not restored');};
      const wait=async predicate=>{const until=Date.now()+8000;while(!predicate()){if(Date.now()>until)throw new Error('Macro API wait timeout');await new Promise(resolve=>setTimeout(resolve,10));}};
      const read=()=>({local:vars.getLocalVariable('apiScanned'),global:vars.getGlobalVariable('apiGlobal'),assembled:vars.getLocalVariable('apiAssembled')});
      // Observe the actual prepareOpenAIMessages snapshot at its RPC boundary;
      // calling snapshotExtensionPrompts again here would add a real macro pass.
      const snapshotPhase=(args,before,source)=>({before,after:read(),entries:JSON.parse(args[1].body).extensionPrompts.map(entry=>({
        key:entry.key,value:entry.value,source:source[entry.key],macrosResolved:entry.macrosResolved,
      }))});
      let hook;
      try{
        await world.saveWorldInfo(name,{entries:{1:{...world.newWorldInfoEntryTemplate,uid:1,key:[],constant:true,content:'API_WORLD={{incvar::apiScanned}}/{{incglobalvar::apiGlobal}}',position:1}}},true);
        world.selected_world_info.splice(0,world.selected_world_info.length,name);
        power.power_user.persona_description='API_PERSONA={{incvar::apiAssembled}}/{{getvar::apiScanned}}';power.power_user.persona_description_position=0;
        for(const experimental of [false,true]){
          power.power_user.experimental_macro_engine=experimental;
          vars.setLocalVariable('apiScanned',0);vars.setLocalVariable('apiAssembled',0);vars.setGlobalVariable('apiGlobal',0);await host.flush();
          const lore=await world.getWorldInfoPrompt([],8192,true);const scanned=read();
          let extensionSnapshot,messages;
          const sources=Object.fromEntries(Object.entries(core.extension_prompts).map(([key,prompt])=>[key,prompt.value]));
          window.fetch=async(...args)=>{
            if(String(args[0])==='/api/conversations/'+originalStory+'/extension-prompt-assembly')extensionSnapshot=snapshotPhase(args,scanned,sources);
            return originalFetch(...args);
          };
          try{[messages]=await openai.prepareOpenAIMessages({messages:[{role:'user',content:'API_INPUT'}],worldInfoBefore:lore.worldInfoBefore,worldInfoAfter:lore.worldInfoAfter},true);}
          finally{window.fetch=originalFetch;}
          const assembled=read();
          const rejectedRequest=await openai.createGenerationParameters({...openai.oai_settings,openai_max_context:512,openai_max_tokens:128},'gpt-4o','quiet',messages);
          const rejected=await originalFetch('/api/backends/chat-completions/generate',{method:'POST',headers:core.getRequestHeaders(),body:JSON.stringify(rejectedRequest.generate_data)});
          const rejectedStatus=rejected.status;await rejected.text();const afterRejected=read();
          const cancelled=new AbortController();cancelled.abort(new Error('Macro API cancelled before transport'));
          let cancellation='';try{await openai.sendOpenAIRequest('quiet',messages,cancelled.signal);}catch(error){cancellation=error.message;}
          const reply=await openai.sendOpenAIRequest('quiet',messages);const afterSend=read();
          const concurrent=await Promise.all([world.getWorldInfoPrompt([],8192,true),world.getWorldInfoPrompt([],8192,true)]);
          let reentered=false;
          hook=async()=>{if(!reentered){reentered=true;await world.getWorldInfoPrompt([],8192,true);}};
          core.eventSource.on(core.event_types.WORLD_INFO_ACTIVATED,hook);
          await world.getWorldInfoPrompt([],8192,false);
          core.eventSource.removeListener(core.event_types.WORLD_INFO_ACTIVATED,hook);hook=undefined;
          const afterReentry=read();
          let held=false,release;const gate=new Promise(resolve=>release=resolve);
          window.fetch=async(...args)=>{if(String(args[0])==='/api/worldinfo/prompt'&&!held){held=true;await gate;}return originalFetch(...args);};
          const conflicted=world.getWorldInfoPrompt([],8192,true).then(()=>'',error=>error.message);
          await wait(()=>held);vars.setLocalVariable('apiScanned',99);vars.setGlobalVariable('apiGlobal',98);await host.flush();
          release();const conflict=await conflicted;window.fetch=originalFetch;const afterConflict=read();
          const recovery=await world.getWorldInfoPrompt([],8192,true);await host.flush();
          const saved=await originalFetch('/api/conversations/'+core.getCurrentChatId()).then(response=>response.json());
          const late=[];
          for(const kind of ['world','assembly']){
            let responseReady=false,deliver;const responseGate=new Promise(resolve=>deliver=resolve);
            let snapshot=null;const snapshotBefore=read();
            const snapshotSources=Object.fromEntries(Object.entries(core.extension_prompts).map(([key,prompt])=>[key,prompt.value]));
            let activations=0;const onActivation=()=>{activations++;};
            core.eventSource.on(core.event_types.WORLD_INFO_ACTIVATED,onActivation);
            window.fetch=async(...args)=>{
              if(kind==='assembly'&&String(args[0])==='/api/conversations/'+originalStory+'/extension-prompt-assembly')snapshot=snapshotPhase(args,snapshotBefore,snapshotSources);
              const response=await originalFetch(...args);
              if(String(args[0])===(kind==='world'?'/api/worldinfo/prompt':'/api/conversations/'+originalStory+'/extension-prompt-assembly')){
                responseReady=true;await responseGate;
              }
              return response;
            };
            const pending=(kind==='world'?world.getWorldInfoPrompt([],8192,false):openai.prepareOpenAIMessages({messages:[{role:'user',content:'late assembly'}],worldInfoBefore:'',worldInfoAfter:''},true)).then(()=>'',error=>error.message);
            try{
              await wait(()=>responseReady);
              await core.selectCharacterById(core.characters.findIndex(item=>item.avatar===otherAvatar));
              const currentStory=core.getCurrentChatId();deliver();
              const error=await pending;
              const live=read(),durable=await originalFetch('/api/conversations/'+originalStory).then(response=>response.json());
              late.push({kind,snapshot,error,activations,switched:currentStory!==originalStory,live,durable:durable.chatMetadata.variables});
            }finally{
              deliver();await pending;window.fetch=originalFetch;
              core.eventSource.removeListener(core.event_types.WORLD_INFO_ACTIVATED,onActivation);
              await selectOriginal();
            }
          }
          results.push({experimental,scanned,extensionSnapshot,assembled,rejectedStatus,afterRejected,cancellation,reply:reply.choices[0].message.content,afterSend,
            concurrent:concurrent.map(value=>value.worldInfoAfter),afterReentry,conflict,afterConflict,recovery:recovery.worldInfoAfter,saved:saved.chatMetadata.variables,late});
        }
        return results;
      }finally{
        window.fetch=originalFetch;if(hook)core.eventSource.removeListener(core.event_types.WORLD_INFO_ACTIVATED,hook);
        world.selected_world_info.splice(0,world.selected_world_info.length,...before.worlds);
        power.power_user.experimental_macro_engine=before.engine;power.power_user.persona_description=before.persona;power.power_user.persona_description_position=before.position;
        for(const key of ['apiScanned','apiAssembled'])vars.deleteLocalVariable(key);vars.deleteGlobalVariable('apiGlobal');
        await world.updateWorldInfoList();await world.deleteWorldInfo(name);await host.flush();
      }
    })()`);
    const snapshotEffects=(phase,experimental)=>experimental?0:phase.entries.length;
    const assertSnapshot=(phase,experimental,before)=>{
      assert(phase,'Actual extension prompt snapshot was not observed');assert.deepEqual(phase.before,before);
      assert.deepEqual(phase.after,{...before,assembled:before.assembled+snapshotEffects(phase,experimental)});
      for(const entry of phase.entries){assert.equal(entry.macrosResolved,true);assert.equal(typeof entry.source,'string');}
    };
    try{for(const value of result){
      assert.deepEqual(value.scanned,{local:1,global:1,assembled:0});
      assertSnapshot(value.extensionSnapshot,value.experimental,value.scanned);
      const assemblyCount=1+snapshotEffects(value.extensionSnapshot,value.experimental);
      assert.deepEqual(value.assembled,{local:1,global:1,assembled:assemblyCount});
      assert.equal(value.rejectedStatus,400);assert.deepEqual(value.afterRejected,value.assembled);assert.equal(value.reply,'Macro API reply');assert.deepEqual(value.afterSend,value.assembled);
      assert.equal(value.cancellation,'Macro API cancelled before transport');
      assert.deepEqual(value.concurrent,['API_WORLD=2/2','API_WORLD=3/3']);assert.deepEqual(value.afterReentry,{local:5,global:5,assembled:assemblyCount});
      assert.match(value.conflict,/已被修改/);assert.deepEqual(value.afterConflict,{local:99,global:98,assembled:assemblyCount});
      assert.equal(value.recovery,'API_WORLD=100/99');assert.equal(value.saved.apiScanned,100);
      assert.equal(value.saved.apiAssembled,assemblyCount);
      for(const late of value.late){
        assert(late.switched);assert.match(late.error,/故事已切换/);assert.equal(late.activations,0);
        assert.equal(late.live.local,'');assert.equal(late.live.assembled,'');assert.equal(late.live.global,100);
        assert.equal(late.durable.apiScanned,101);
        if(late.kind==='world'){assert.equal(late.snapshot,null);assert.equal(late.durable.apiAssembled,assemblyCount);}
        else{
          assertSnapshot(late.snapshot,value.experimental,{local:101,global:100,assembled:assemblyCount});
          assert.equal(late.durable.apiAssembled,assemblyCount+snapshotEffects(late.snapshot,value.experimental)+1);
        }
      }
    }
    assert.equal(bodies.length,2);
    for(const [index,body] of bodies.entries()){
      const value=result[index],assemblyCount=1+snapshotEffects(value.extensionSnapshot,value.experimental);
      assert(JSON.stringify(body.messages).includes('API_WORLD=1/1'));assert(JSON.stringify(body.messages).includes('API_PERSONA='+assemblyCount+'/1'));
    }}catch(error){console.error('Extension macro lifecycle fixture observations: '+JSON.stringify(result));throw error;}
    return {passed:true,modes:result.map(value=>value.experimental?'experimental':'legacy'),snapshotPhases:result.map(value=>({
      experimental:value.experimental,initial:value.extensionSnapshot,lateAssembly:value.late.find(item=>item.kind==='assembly').snapshot,
    })),stages:[
      'public-world-info-effects-reach-assembly-browser-and-durable-storage',
      'actual-extension-snapshot-records-one-legacy-card-read-per-selected-entry-before-rpc-and-no-new-engine-read',
      'public-dry-run-retains-tavern-variable-effects',
      'budget-rejection-and-transport-never-repeat-or-rollback-earlier-public-api-effects',
      'concurrent-scans-and-reentrant-activation-listeners-complete-with-ordered-state',
      'concurrent-variable-writer-rejects-stale-scan-without-partial-commit-and-recovers',
      'late-world-and-assembly-responses-reject-after-real-story-navigation-without-publishing-stale-prompts']};
  }finally{await service.inject({method:'PUT',url:'/api/settings/provider',payload:provider});model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
}

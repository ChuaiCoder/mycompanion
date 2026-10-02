import assert from 'node:assert/strict';
import {createServer} from 'node:http';

// Called only by the existing temporary-profile Electron/portable runners.
// Browser edits stay in memory; the native test owns a separate disposable card.
export async function verifyCharacterMacroPhases(window,service){
  const evaluate=source=>window.webContents.executeJavaScript(source);
  const browser=await evaluate(`(async()=>{
    const core=await import('/script.js'),power=await import('/scripts/power-user.js'),vars=await import('/scripts/variables.js');
    const host=await import('/plugin-runtime/desktop-host.js');await host.flush();
    const character=core.characters[core.this_chid],beforeCharacter=structuredClone(character);
    const powerKeys=['experimental_macro_engine','prefer_character_prompt','prefer_character_jailbreak','persona_description','collapse_newlines'];
    const beforePower=Object.fromEntries(powerKeys.map(key=>[key,power.power_user[key]]));
    const metadataKeys=['system_prompt','mes_example','scenario'];
    const beforeMetadata=Object.fromEntries(metadataKeys.map(key=>[key,core.chat_metadata[key]]));
    const phase=()=>vars.getLocalVariable('cardPhaseCounter'),trace=()=>vars.getLocalVariable('cardPhaseTrace');
    const field=label=>label+'={{incvar::cardPhaseCounter}}{{addvar::cardPhaseTrace::'+label+'>}}';
    const fixture={system_prompt:field('SYSTEM'),mes_example:field('EXAMPLES'),description:field('DESCRIPTION'),personality:field('PERSONALITY'),
      scenario:field('SCENARIO'),post_history_instructions:field('JAILBREAK'),character_version:'{{incvar::cardVersionCounter}}',
      extensions:{...character.data.extensions,depth_prompt:{prompt:field('DEPTH')}},creator_notes:field('NOTES'),
      first_mes:field('FIRST'),alternate_greetings:[field('ALTERNATE')]};
    const results=[];
    try{
      for(const key of metadataKeys)delete core.chat_metadata[key];
      Object.assign(character.data,fixture);
      for(const key of ['description','personality','scenario','mes_example','first_mes'])character[key]=fixture[key];
      power.power_user.prefer_character_prompt=true;power.power_user.prefer_character_jailbreak=true;
      power.power_user.persona_description=field('PERSONA');
      for(const experimental of [false,true]){
        power.power_user.experimental_macro_engine=experimental;power.power_user.collapse_newlines=false;
        vars.setLocalVariable('cardPhaseCounter',0);vars.setLocalVariable('cardPhaseTrace','');
        const empty=core.substituteParams(''),afterEmpty=phase();
        const plain=core.substituteParams('plain text'),afterPlain=phase(),plainTrace=trace();
        const duplicate=core.substituteParams('{{description}}/{{description}}'),afterDuplicate=phase();
        const lazy=core.getCharacterCardFieldsLazy(),beforeRead=phase(),first=lazy.description,again=lazy.description,afterRead=phase();
        const next=core.getCharacterCardFieldsLazy().description,afterNext=phase();
        const eager=core.getCharacterCardFields(),afterEager=phase();
        core.substituteParams('next plain text');const afterNextCall=phase();
        const versionEffect=vars.existsLocalVariable('cardVersionCounter');
        power.power_user.collapse_newlines=true;
        character.description=character.data.description=' \\r\\n{{user}}/{{char}}\\r\\n\\n\\nX\\r\\n ';
        const named=core.getCharacterCardFieldsLazy();
        const names={user:core.name1,char:core.name2,description:named.description,again:named.description,
          override:core.baseChatReplace('{{user}}/{{char}}\\r\\n\\n\\nX','OverrideReader','OverrideActor'),
          recursiveCard:core.baseChatReplace('x{{description}}y')};
        results.push({experimental,empty,afterEmpty,plain,afterPlain,plainTrace,duplicate,afterDuplicate,beforeRead,first,again,afterRead,next,afterNext,
          eager,afterEager,afterNextCall,versionEffect,names});
        character.description=character.data.description=fixture.description;
      }
      return results;
    }finally{
      for(const key of Object.keys(character))delete character[key];Object.assign(character,beforeCharacter);
      for(const [key,value] of Object.entries(beforePower)){if(value===undefined)delete power.power_user[key];else power.power_user[key]=value;}
      for(const [key,value] of Object.entries(beforeMetadata)){if(value===undefined)delete core.chat_metadata[key];else core.chat_metadata[key]=value;}
      for(const key of ['cardPhaseCounter','cardPhaseTrace','cardVersionCounter'])vars.deleteLocalVariable(key);
      await host.flush();
    }
  })()`);
  const fieldOrder=['SYSTEM','EXAMPLES','DESCRIPTION','PERSONALITY','PERSONA','SCENARIO','JAILBREAK','DEPTH','NOTES','FIRST','ALTERNATE'];
  for(const run of browser){
    const legacy=!run.experimental;
    assert.equal(run.empty,'');assert.equal(run.afterEmpty,0);assert.equal(run.plain,'plain text');
    assert.equal(run.afterPlain,legacy?11:0);assert.equal(run.plainTrace,legacy?fieldOrder.map(label=>label+'>').join(''):'');
    assert.equal(run.duplicate,legacy?'DESCRIPTION=14/DESCRIPTION=14':'DESCRIPTION=1/DESCRIPTION=1');
    assert.equal(run.afterDuplicate,legacy?22:1);assert.equal(run.beforeRead,run.afterDuplicate);
    assert.equal(run.first,'DESCRIPTION='+(legacy?23:2));assert.equal(run.again,run.first);
    assert.equal(run.afterRead,legacy?23:2);assert.equal(run.next,'DESCRIPTION='+(legacy?24:3));assert.equal(run.afterNext,legacy?24:3);
    assert.equal(run.afterEager-run.afterNext,11);assert.equal(run.eager.description,'DESCRIPTION='+(legacy?27:6));
    for(const [key,label,index] of [['system','SYSTEM',1],['mesExamples','EXAMPLES',2],['description','DESCRIPTION',3],['personality','PERSONALITY',4],
      ['persona','PERSONA',5],['scenario','SCENARIO',6],['jailbreak','JAILBREAK',7],['charDepthPrompt','DEPTH',8],['creatorNotes','NOTES',9],['firstMessage','FIRST',10]])
      assert.equal(run.eager[key],label+'='+(run.afterNext+index));
    assert.deepEqual(run.eager.alternateGreetings,['ALTERNATE='+(run.afterNext+11)]);
    assert.equal(run.afterNextCall,legacy?46:14);assert.equal(run.versionEffect,false);assert.equal(run.eager.version,'{{incvar::cardVersionCounter}}');
    assert.equal(run.names.description,run.names.user+'/'+run.names.char+'\nX');assert.equal(run.names.again,run.names.description);
    assert.equal(run.names.override,'OverrideReader/OverrideActor\nX');assert.equal(run.names.recursiveCard,legacy?'x{{description}}y':'xy');
  }
  const publicWorldOverrides=await verifyPublicWorldOverrides(window,service);
  const native=await verifyNativeCharacterWorldPhase(window,service);
  return {passed:true,modes:browser.map(run=>run.experimental?'experimental':'legacy'),publicWorldOverrides,native,stages:[
    'legacy-plain-text-eagerly-reads-eleven-fields-in-tavern-order-and-new-engine-reads-none',
    'card-fields-cache-only-within-each-public-snapshot-and-evaluate-again-on-next-call',
    'public-lazy-fields-use-live-names-and-tavern-cr-collapse-rules-with-recursion-disabled',
    'raw-card-version-does-not-execute-variable-effects']};
}

// Exercise the public entrypoint over its real browser -> service ESM/HTTP path.
// Supplied WI strings already came from scanning; omitted strings mean no WI.
export async function verifyPublicWorldOverrides(window,service){
  const result=await window.webContents.executeJavaScript(`(async()=>{
    const core=await import('/script.js'),openai=await import('/scripts/openai.js'),world=await import('/scripts/world-info.js');
    const power=await import('/scripts/power-user.js'),vars=await import('/scripts/variables.js'),host=await import('/plugin-runtime/desktop-host.js');
    await host.flush();
    const before={engine:power.power_user.experimental_macro_engine,worlds:[...world.selected_world_info]};
    const originalFetch=window.fetch,name='mc-public-world-overrides',runs=[];
    const base={messages:[{role:'user',content:'PUBLIC_WI_INPUT'}],extensionPrompts:[],messageExamples:[],charDescription:'PUBLIC_WI_CARD',
      charPersonality:'',scenario:'',systemPromptOverride:'',jailbreakPromptOverride:'',personaDescription:''};
    const cases=[
      ['missing',{},[]],['empty',{worldInfoBefore:'',worldInfoAfter:''},[]],
      ['before-empty',{worldInfoBefore:''},[]],['after-empty',{worldInfoAfter:''},[]],
      ['before-only',{worldInfoBefore:'PUBLIC_BEFORE_ONLY'},['PUBLIC_BEFORE_ONLY']],
      ['after-only',{worldInfoAfter:'PUBLIC_AFTER_ONLY'},['PUBLIC_AFTER_ONLY']],
      ['both',{worldInfoBefore:'PUBLIC_BEFORE_BOTH',worldInfoAfter:'PUBLIC_AFTER_BOTH'},['PUBLIC_BEFORE_BOTH','PUBLIC_AFTER_BOTH']],
      ['literal-macro',{worldInfoBefore:'PUBLIC_WI_LITERAL={{incvar::publicWiProvided}}'},['PUBLIC_WI_LITERAL={{incvar::publicWiProvided}}']],
    ];
    const reset=async()=>{vars.deleteLocalVariable('publicWiImplicit');vars.deleteLocalVariable('publicWiProvided');await host.flush();};
    try{
      await world.saveWorldInfo(name,{entries:{1:{...world.newWorldInfoEntryTemplate,uid:1,key:[],constant:true,
        content:'PUBLIC_WI_AUTO={{incvar::publicWiImplicit}}',position:1}}},true);
      world.selected_world_info.splice(0,world.selected_world_info.length,name);
      for(const experimental of [false,true]){
        power.power_user.experimental_macro_engine=experimental;await reset();
        const selected=await world.getWorldInfoPrompt([],8192,true);
        const activationControl={text:selected.worldInfoAfter,counter:vars.getLocalVariable('publicWiImplicit')};
        const checks=[];
        for(const [label,overrides,expected] of cases){
          await reset();let report;
          window.fetch=async(...args)=>{
            const response=await originalFetch(...args);
            if(String(args[0])==='/api/conversations/'+core.getCurrentChatId()+'/extension-prompt-assembly')report=await response.clone().json();
            return response;
          };
          let messages,counts;
          try{[messages,counts]=await openai.prepareOpenAIMessages({...base,...overrides},true);}
          finally{window.fetch=originalFetch;}
          const saved=await originalFetch('/api/conversations/'+core.getCurrentChatId()).then(response=>response.json());
          checks.push({label,expected,messages,counts,report,implicit:vars.existsLocalVariable('publicWiImplicit'),provided:vars.existsLocalVariable('publicWiProvided'),
            durableImplicit:Object.hasOwn(saved.chatMetadata.variables??{},'publicWiImplicit'),durableProvided:Object.hasOwn(saved.chatMetadata.variables??{},'publicWiProvided')});
        }
        runs.push({experimental,activationControl,checks});
      }
      return runs;
    }finally{
      window.fetch=originalFetch;world.selected_world_info.splice(0,world.selected_world_info.length,...before.worlds);
      if(before.engine===undefined)delete power.power_user.experimental_macro_engine;else power.power_user.experimental_macro_engine=before.engine;
      vars.deleteLocalVariable('publicWiImplicit');vars.deleteLocalVariable('publicWiProvided');
      await world.updateWorldInfoList();await world.deleteWorldInfo(name);await host.flush();
    }
  })()`);
  try{for(const run of result){
    assert.deepEqual(run.activationControl,{text:'PUBLIC_WI_AUTO=1',counter:1},'Selected constant WI fixture did not execute through explicit scanning');
    for(const check of run.checks){
      const text=check.messages.map(message=>message.content).join('\n');
      assert(!text.includes('PUBLIC_WI_AUTO'),'Public assembly implicitly scanned saved world info: '+check.label);
      assert.deepEqual([check.implicit,check.provided,check.durableImplicit,check.durableProvided],[false,false,false,false],
        'Public WI overrides executed extra variable effects: '+check.label);
      assert.deepEqual(check.report.macroChanges,[],'Public WI assembly committed unrequested macro effects: '+check.label);
      for(const marker of check.expected)assert(text.includes(marker),'Public assembly lost explicit world info: '+check.label);
      const worldTokens=check.report.regions.filter(region=>region.key==='worldbook'||region.key==='worldbook_constant').reduce((total,region)=>total+region.tokens,0);
      const handlerTokens=Object.entries(check.counts).filter(([key])=>key==='worldbook'||key==='worldbook_constant').reduce((total,[,tokens])=>total+tokens,0);
      assert.equal(handlerTokens,worldTokens,'Public token handler diverged from service WI budget');
      assert.equal(worldTokens>0,check.expected.length>0,'Explicit WI strings were not budgeted correctly: '+check.label);
      if(check.label==='both')assert(text.indexOf('PUBLIC_BEFORE_BOTH')<text.indexOf('PUBLIC_WI_CARD')&&
        text.indexOf('PUBLIC_WI_CARD')<text.indexOf('PUBLIC_AFTER_BOTH'),'Before/after WI lost their placement around the card');
    }
  }}catch(error){console.error('Public WI override fixture observations: '+JSON.stringify(result));throw error;}
  return {passed:true,modes:result.map(run=>run.experimental?'experimental':'legacy'),cases:result.flatMap(run=>run.checks.map(check=>({
    experimental:run.experimental,label:check.label,worldTokens:check.report.regions.filter(region=>region.key==='worldbook'||region.key==='worldbook_constant').reduce((total,region)=>total+region.tokens,0),
  }))),stages:[
    'public-missing-empty-and-one-sided-wi-arguments-never-scan-selected-constant-world-info',
    'explicit-before-after-wi-strings-keep-placement-and-service-browser-token-counts',
    'already-scanned-wi-text-does-not-reexecute-residual-variable-macros']};
}

async function verifyNativeCharacterWorldPhase(window,service){
  const provider=(await service.inject({method:'GET',url:'/api/settings/provider'})).json();
  const originalSettings=(await service.inject({method:'GET',url:'/api/extensions/settings'})).json().extensionSettings;
  const originalWorld=(await service.inject({method:'GET',url:'/api/worldinfo/settings'})).json();
  const name='mc-native-character-phase',bodies=[],characters=[];let worldCreated=false;
  const model=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;const body=JSON.parse(raw);bodies.push(body);
    if(body.stream){response.writeHead(200,{'Content-Type':'text/event-stream'});
      response.end('data: '+JSON.stringify({choices:[{delta:{content:'Character phase reply'}}]})+'\n\ndata: [DONE]\n\n');}
    else{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{message:{content:'Character phase reply'}}]}));}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
  const request=async(method,url,payload,status=200)=>{
    const response=await service.inject({method,url,...(payload===undefined?{}:{payload})});
    const data=response.json();
    assert.equal(response.statusCode,status,'Character phase fixture request '+method+' '+url+'\n'+(response.body??JSON.stringify(data)));return data;
  };
  const field=label=>label+'={{incvar::nativeCardPhase}}';
  try{
    await request('PUT','/api/settings/provider',{kind:'ollama',baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'gpt-4o',contextLimitTokens:8192,maxTokens:128});
    await request('POST','/api/worldinfo/edit',{name,data:{entries:{
      1:{uid:1,key:[],constant:true,content:'NATIVE_WORLD={{getvar::nativeCardPhase}}',position:1},
      2:{uid:2,key:['/DESCRIPTION=\\d+/'],matchCharacterDescription:true,content:'NATIVE_MATCH={{getvar::nativeCardPhase}}',position:1},
    }}});worldCreated=true;
    await request('PUT','/api/worldinfo/settings',{...originalWorld,world_info:{globalSelect:[name],charLore:[]}});
    const runs=[];
    for(const experimental of [false,true]){
      await request('PUT','/api/extensions/settings',{extensionSettings:{...originalSettings,__mycompanion_power_user:{
        ...originalSettings.__mycompanion_power_user,experimental_macro_engine:experimental,prefer_character_prompt:true,prefer_character_jailbreak:true,
        persona_description:field('PERSONA'),persona_description_position:0,
      }}});
      const character=await request('POST','/api/characters/import/commit',{filename:'native-character-phase.json',card:{spec:'chara_card_v2',spec_version:'2.0',data:{
        name:'Native character phase '+experimental,system_prompt:field('SYSTEM'),mes_example:'{{char}}: '+field('EXAMPLES'),description:field('DESCRIPTION'),
        personality:field('PERSONALITY'),scenario:field('SCENARIO'),post_history_instructions:field('JAILBREAK'),creator_notes:field('NOTES'),
        first_mes:field('FIRST'),alternate_greetings:[field('ALTERNATE')],character_version:'{{incvar::nativeVersionEffect}}',
        tags:[],creator:'MyCompanion integration fixture',
        extensions:{depth_prompt:{prompt:field('DEPTH'),depth:2,role:'system'}},
      }}},201);characters.push(character.id);
      const story=await request('POST','/api/conversations',{characterId:character.id},201);
      const before=await request('GET','/api/conversations/'+story.id);
      const result=await window.webContents.executeJavaScript(`(async()=>{
        const story=${JSON.stringify(story.id)},results=[];
        for(const [path,payload] of [['prompt-preview',{}],['messages',{content:'',allowEmpty:true}],['quiet-generation',{}]]){
          const response=await fetch('/api/conversations/'+story+'/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
          if(!response.ok)throw new Error(await response.text());
          const result=path==='messages'?{path,events:await response.text()}:{path,data:await response.json()};
          const saved=await fetch('/api/conversations/'+story);if(!saved.ok)throw new Error(await saved.text());
          result.stored=await saved.json();results.push(result);
        }
        return results;
      })()`);
      const preview=result[0].data,normal=bodies[bodies.length-2],quiet=bodies[bodies.length-1];
      const assertMessages=(messages,round)=>{
        // Pinned-upstream oracle: first-card + WI key + two selected contents +
        // persona calls own five legacy card environments. The experimental
        // engine keeps those later getters lazy because no card macro is used.
        const readCount=experimental?1:5,perRound=readCount*11+1;
        const text=messages.map(item=>item.content).join('\n'),offset=(round-1)*perRound;
        for(const [label,index] of [['SYSTEM',1],['EXAMPLES',2],['DESCRIPTION',3],['PERSONALITY',4],['SCENARIO',6],['JAILBREAK',7]])
          assert(text.includes(label+'='+(offset+index)),label+' field order was lost');
        assert(text.includes('NATIVE_WORLD='+(offset+(experimental?11:33))),'WI content lost its independent card environment');
        assert(text.includes('NATIVE_MATCH='+(offset+(experimental?11:44))),'WI did not match the resolved description');
        assert(text.includes('PERSONA='+(offset+perRound)),'IN_PROMPT persona did not retain its separate evaluation');
      };
      assertMessages(preview.messages,1);assertMessages(normal.messages,1);assertMessages(quiet.messages,2);
      assert.deepEqual(result[0].stored,before,'Native preview persisted character macro effects');
      const perRound=experimental?12:56;
      assert.equal(result[1].stored.chatMetadata.variables.nativeCardPhase,perRound);
      assert.equal(result[2].stored.chatMetadata.variables.nativeCardPhase,perRound*2);
      assert.deepEqual(result[2].stored.messages,result[1].stored.messages,'Quiet generation changed native message history');
      assert.deepEqual(normal.messages,preview.messages,'Native preview and real provider request diverged');
      assert(result[1].events.includes('Character phase reply'));assert.equal(result[2].data.text,'Character phase reply');
      const after=await request('GET','/api/conversations/'+story.id);
      assert.deepEqual(before.chatMetadata.variables??{},{});assert.equal(after.chatMetadata.variables.nativeCardPhase,perRound*2);
      assert.equal(after.chatMetadata.variables.nativeVersionEffect,undefined);assert.equal(after.messages.length,before.messages.length+1);
      runs.push({experimental,phase:after.chatMetadata.variables.nativeCardPhase,providerRequests:2});
    }
    assert.equal(bodies.length,4);
    return {passed:true,runs,providerRequests:bodies.length,stages:[
      'native-preview-normal-and-quiet-http-paths-read-the-complete-card-before-world-info',
      'world-info-matches-resolved-card-fields-and-sees-their-variable-effects',
      'native-preview-matches-the-provider-prompt-and-normal-quiet-commit-independent-drafts']};
  }finally{
    try{
      await request('PUT','/api/settings/provider',provider);
      await request('PUT','/api/extensions/settings',{extensionSettings:originalSettings});
      await request('PUT','/api/worldinfo/settings',originalWorld);
      if(worldCreated)await request('POST','/api/worldinfo/delete',{name});
      for(const id of characters)await request('DELETE','/api/characters/'+id+'?permanent=true');
    }finally{model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}
  }
}

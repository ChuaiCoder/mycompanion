// SPDX-License-Identifier: AGPL-3.0-only
import { reportUrl, upstreamPublicUrl, writeFixtures } from './oracle-paths.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeContext, productCard } from './prompt-population-upstream-oracle-20261002.mjs';
import { assembleModelPrompt, characterWithChatOverrides } from '../../apps/local-service/dist/providers/model-client.js';
import { MacroEvaluationSession } from '../../apps/local-service/dist/prompt/prompt-macros.js';
import { bindCharacterMacroEnvironment, prepareCharacterMacroFields } from '../../apps/local-service/dist/character/character-macros.js';
const json=value=>JSON.parse(JSON.stringify(value)),runs=[];
const settings={kind:'ollama',baseUrl:'http://provider.test/v1',model:'gpt-4o',maxTokens:128,contextLimitTokens:4096,temperature:0.7,hasApiKey:false};
for(const experimental of [false,true])for(const mode of ['public-overrides','native-vars','residual-card','injection-buckets','send-empty','send-empty-unfit']){
  const selected=mode==='public-overrides'?{name:'Public override',first_mes:'FIRST={{incvar::unusedFirst}}',description:'CARD={{incvar::unusedDescription}}',personality:'PERSONALITY={{incvar::unusedPersonality}}',scenario:'SCENARIO={{incvar::unusedScenario}}',mes_example:'EXAMPLES={{incvar::unusedExamples}}',data:{system_prompt:'SAVED_SYSTEM={{incvar::unusedSystem}}',post_history_instructions:'SAVED_PHI={{incvar::unusedPhi}}',creator_notes:'NOTES={{incvar::unusedNotes}}',alternate_greetings:['ALT={{incvar::unusedAlternate}}'],extensions:{depth_prompt:{prompt:'DEPTH={{incvar::unusedDepth}}',depth:2,role:'system'}}}}:
    mode==='native-vars'?{name:'Macro',first_mes:'Hello',description:'CARD={{incvar::card}}/{{incglobalvar::global}}',data:{}}:
    mode==='residual-card'?{name:'MacroCard',first_mes:'Opening',description:'{{getvar::outer}}/{{model}}{{newline}}END',data:{}}:
    {name:'Injector',first_mes:'Greeting',description:'CHARACTER_CORE',data:{}};
  Object.assign(selected,{personality:selected.personality??'',scenario:selected.scenario??'',mes_example:selected.mes_example??''});Object.assign(selected.data,{system_prompt:selected.data.system_prompt??'',post_history_instructions:selected.data.post_history_instructions??'',creator_notes:selected.data.creator_notes??'',alternate_greetings:selected.data.alternate_greetings??[],extensions:selected.data.extensions??{},character_version:''});
  selected.data.extensions.depth_prompt??={prompt:''};
  const persona=mode==='public-overrides'?'PERSONA={{incvar::unusedPersona}}':mode==='native-vars'?'PERSONA={{incvar::persona}}':'';
  const powers={experimental_macro_engine:experimental,persona_description:persona,persona_description_position:0,prefer_character_prompt:mode!=='public-overrides',prefer_character_jailbreak:mode!=='public-overrides'};
  const extensions=mode==='native-vars'?{once:{value:'EXT={{incvar::extension}}',position:1,depth:0,role:0,scan:true}}:
    mode==='injection-buckets'?Object.fromEntries([['before','BEFORE',2,0,1],['relative','RELATIVE',0,0,2],['tail-z','TAIL_Z',1,0,0],['tail-a','TAIL_A',1,0,0],['deep','DEEP {{char}}',1,10000,0],['middle','MIDDLE',1,1,1],['tail-assistant','TAIL_ASSISTANT',1,0,2]].map(([key,value,position,depth,role])=>[key,{value,position,depth,role,scan:false}])):{};
  let metadata={variables:mode==='residual-card'?{outer:'{{getvar::inner}}',inner:'expanded twice'}:{},chat_id_hash:1};
  const extensionSettings={__mycompanion_power_user:powers},character=productCard(selected),upstream=makeContext(selected,persona,experimental,metadata,extensions,powers);
  if(mode==='public-overrides')upstream.power_user.persona_description_position=2; // one-request suppression adapter; raw persona getter remains active.
  if(mode.startsWith('send-empty'))upstream.oai_settings.send_if_empty=mode==='send-empty'?'SEND_EMPTY':'long '.repeat(5000);
  for(const round of mode==='public-overrides'?[1,2]:mode==='native-vars'?[1,2,3,4]:[1]){
    const skipped=mode==='native-vars'&&round===4,type=mode==='native-vars'&&round>1?'quiet':'normal';
    if(skipped){powers.persona_description_position=2;upstream.power_user.persona_description_position=2;}
    const session=new MacroEvaluationSession(metadata,extensionSettings),traces=[],evaluate=session.evaluate.bind(session),traceStart=upstream.traces.length,readStart=upstream.reads.length;
    session.evaluate=(text,context)=>{const result=evaluate(text,context);if(context.replaceCharacterCard!==false)traces.push({content:text,result});return result;};
    bindCharacterMacroEnvironment(character,metadata,extensionSettings,settings,session);
    let fields={description:'Explicit description',personality:'',scenario:'',system:'SYSTEM={{incvar::systemOverride}}',jailbreak:'PHI={{incvar::phiOverride}}',mesExamples:''},wi='';
    if(mode!=='public-overrides'){
      fields=prepareCharacterMacroFields(character,metadata,extensionSettings,settings,session);
      const expectedFields=vm.runInContext('getCharacterCardFields()',upstream);assert.deepEqual(json(fields),json(expectedFields));
      if(mode==='native-vars'&&!skipped){
        for(const text of ['EXT={{incvar::extension}}','absent-key','WORLD={{incvar::world}}']){
          const value=session.evaluate(text,{characterName:character.name,userName:'User',model:settings.model,experimentalMacroEngine:experimental});upstream.text=text;assert.equal(value,vm.runInContext('substituteParams(text)',upstream));
          if(text.startsWith('WORLD='))wi=value;
        }
      }
    }
    const history=mode==='public-overrides'?[{role:'user',content:'Input'}]:mode==='residual-card'||mode==='injection-buckets'?[{role:'assistant',content:selected.first_mes},{role:'user',content:'Current input'}]:[{role:'assistant',content:selected.first_mes},...(mode==='native-vars'&&round>1?[{role:'assistant',content:'reply'}]:[])];
    const productSettings=mode==='send-empty-unfit'?{...settings,contextLimitTokens:1024}:settings;
    const productExtensions=skipped?[]:Object.entries(extensions).map(([key,value])=>({key,...value}));
    const actual=assembleModelPrompt({settings:productSettings,character:mode==='public-overrides'?{...character,description:fields.description,personality:'',scenario:'',systemPrompt:fields.system,postHistoryInstructions:fields.jailbreak}:character,
      history:history.map(message=>({...message,id:randomUUID(),conversationId:randomUUID(),branchId:randomUUID(),parentMessageId:null,status:'complete',createdAt:new Date().toISOString()})),
      memory:{conversationId:randomUUID(),results:[],block:'',position:'before_recent_messages',budgetTokens:500,injectedCount:0,durationMs:0},plugins:[],
      lorebook:{characterId:character.id,results:wi?[{index:1,name:'world',status:'injected',matchedKey:null,tokens:0,diagnostics:[],content:wi,position:1}]:[],block:wi,constantBlock:'',position:'after_character_core',budgetTokens:500,injectedCount:0,durationMs:0},
      messageExamples:[],macroSession:session,extensionSettings:{...extensionSettings,...(mode.startsWith('send-empty')?{__mycompanion_openai:{settings:{send_if_empty:upstream.oai_settings.send_if_empty}}}:{})},chatMetadata:metadata,prepareNativeCharacterFields:mode!=='public-overrides',characterOverridesResolved:mode==='public-overrides',
      ...(mode==='public-overrides'?{personaDescriptionOverride:''}:{}),generationType:type,...(type==='quiet'?{quietPrompt:''}:{}),skipAuthorNote:skipped,extensionPrompts:productExtensions});
    upstream.extension_prompts=skipped?{}:extensions;upstream.history=history;upstream.input={scenario:fields.scenario,charPersonality:fields.personality,charDescription:fields.description,worldInfoBefore:'',worldInfoAfter:wi,extensionPrompts:upstream.extension_prompts,systemPromptOverride:fields.system,jailbreakPromptOverride:fields.jailbreak,
      ...(mode==='public-overrides'?{personaDescription:''}:{}),type,...(type==='quiet'?{quietPrompt:''}:{})};
    const expected=await vm.runInContext(`(async()=>{const prompts=await preparePromptsForChatCompletion(input),completion=new ChatCompletion();completion.setTokenBudget(${productSettings.contextLimitTokens},128+512);await populateChatCompletion(prompts,completion,{...input,messages:history.slice().reverse(),messageExamples:[]});return completion.getChat();})()`,upstream);
    assert.deepEqual(json(actual.messages),json(expected),mode+' messages round'+round);assert.deepEqual(json(session.local),json(upstream.chat_metadata.variables),mode+' variables round'+round);assert.deepEqual(json(session.global),json(upstream.extension_settings.variables.global),mode+' globals round'+round);
    assert.deepEqual(traces.map(call=>[call.content,call.result]),upstream.traces.slice(traceStart).map(call=>[call.content??'',call.result]),mode+' per-call trace round'+round);
    runs.push({mode,experimental,round,passed:true,upstream:{messages:json(expected),variables:json(upstream.chat_metadata.variables),global:json(upstream.extension_settings.variables.global),traces:json(upstream.traces.slice(traceStart)),reads:json(upstream.reads.slice(readStart))},product:{messages:json(actual.messages),variables:json(session.local),traces}});
    // round 3 is a dry run. Discard its variable draft before the skipped run.
    if(mode==='native-vars'&&round===3){upstream.chat_metadata.variables=json(metadata.variables);upstream.extension_settings.variables.global=json(extensionSettings.variables.global);}
    else{metadata={...metadata,variables:json(session.local)};extensionSettings.variables={global:json(session.global)};}
  }
}
writeFileSync(reportUrl('prompt-remaining-upstream-oracle-20261002.json'),JSON.stringify({passed:true,upstreamCommit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',runs},null,2)+'\n');
if(writeFixtures)writeFileSync(new URL('../../apps/local-service/src/fixtures/prompt-remaining-upstream-reference.json',import.meta.url),JSON.stringify({upstreamCommit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',oracle:'scripts/upstream-oracles/prompt-remaining-upstream-oracle-20261002.mjs',runs:runs.map(({mode,experimental,round,upstream})=>({mode,experimental,round,messages:upstream.messages,variables:upstream.variables,global:upstream.global}))},null,2)+'\n');
console.log(JSON.stringify({passed:true,cases:runs.length}));




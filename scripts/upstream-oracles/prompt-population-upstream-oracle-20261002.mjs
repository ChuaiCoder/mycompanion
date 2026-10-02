// SPDX-License-Identifier: AGPL-3.0-only
import { reportUrl, upstreamPublicUrl, writeFixtures } from './oracle-paths.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { source as macroSource, declarations, files } from './native-legacy-upstream-oracle-20261002.mjs';
import { MacroEngine, MacroEnvironmentBuilder, createVariableStores } from '../../packages/macro-engine/src/index.js';
import { readPromptManagerSettings } from '../../apps/local-service/dist/prompt-manager-core.js';
import { assembleModelPrompt, characterWithChatOverrides } from '../../apps/local-service/dist/model-client.js';
import { MacroEvaluationSession } from '../../apps/local-service/dist/prompt-macros.js';
import { prepareCharacterMacroFields, bindCharacterMacroEnvironment, buildCharacterDepthPrompt } from '../../apps/local-service/dist/character-macros.js';
import { countCompatibilityMessagesSync } from '../../apps/local-service/dist/tokenizer-service.js';
const original=macroSource+'\nconst DEFAULT_ORDER=100,DEFAULT_DEPTH=4,MAX_INJECTION_DEPTH=10000;\n'+
  declarations('scripts/PromptManager.js',['Prompt','PromptCollection','PromptManager'])+'\n'+
  declarations('script.js',['getExtensionPrompt','getExtensionPromptMaxDepth'])+'\n'+
  declarations('scripts/openai.js',['formatWorldInfo','preparePromptsForChatCompletion','getPromptRole','getPromptPosition','parseExampleIntoIndividual',
    'IdentifierNotFoundError','TokenBudgetExceededError','InvalidCharacterNameError','Message','MessageCollection','ChatCompletion',
    'populationInjectionPrompts','populateChatHistory','populateDialogueExamples','populateChatCompletion'])+'\n'+declarations('scripts/utils.js',['stringFormat'])+'\n'+declarations('scripts/power-user.js',['collapseNewlines']);
const json=value=>JSON.parse(JSON.stringify(value));
const field=(label,key)=>`${label}={{incvar::phase}}/{{incvar::${key}}}{{addvar::trace::${label}>}}`;
const card={name:'Character macro phases',description:field('D','descriptionRuns'),personality:field('P','personalityRuns'),scenario:field('SCENARIO','scenarioRuns'),
  mes_example:field('E','exampleRuns'),first_mes:field('FIRST','firstRuns'),data:{system_prompt:field('S','systemRuns'),post_history_instructions:field('PHI','jailbreakRuns'),
    creator_notes:field('NOTES','notesRuns'),alternate_greetings:[field('ALT','alternateRuns')],character_version:'{{incvar::versionRuns}}',extensions:{depth_prompt:{prompt:field('DEPTH','depthRuns'),depth:2,role:'system'}}}};
const counters=['systemRuns','exampleRuns','descriptionRuns','personalityRuns','personaRuns','scenarioRuns','jailbreakRuns','depthRuns','notesRuns','firstRuns','alternateRuns'];
const world='WORLD={{getvar::phase}};'+counters.map(key=>`${key}={{getvar::${key}}}`).join(';')+';TRACE={{getvar::trace}}';
const settings={kind:'ollama',baseUrl:'http://provider.test/v1',model:'gpt-4o',maxTokens:128,contextLimitTokens:4096,temperature:0.7,hasApiKey:false};
export function makeContext(selected,persona,experimental,metadata={},extensions={},powerOverrides={}){
  const traces=[],reads=[],ctx=vm.createContext({console:{...console,debug:()=>{},warn:()=>{}},structuredClone,uuidv4:randomUUID,
    characters:[selected],this_chid:0,selected_group:null,groups:[],name1:'User',name2:selected.name,main_api:'openai',chat:[],chat_metadata:json(metadata),
    extension_settings:{variables:{global:{}}},accountStorage:{getItem:()=> 'true'},getGeneratingModel:()=> 'gpt-4o',getInstructMacros:()=>[],getGroupNames:()=>[],
    saveMetadataDebounced:()=>{},saveSettingsDebounced:()=>{},
    power_user:{experimental_macro_engine:experimental,prefer_character_prompt:true,prefer_character_jailbreak:true,persona_description:persona,persona_description_position:0,
      collapse_newlines:false,pin_examples:false,instruct:{enabled:false},context:{example_separator:''},...powerOverrides},
    persona_description_positions:{IN_PROMPT:0},extension_prompt_types:{IN_PROMPT:0,IN_CHAT:1,BEFORE_PROMPT:2,NONE:-1},extension_prompt_roles:{SYSTEM:0,USER:1,ASSISTANT:2},
    INJECTION_POSITION:{RELATIVE:0,ABSOLUTE:1},character_names_behavior:{NONE:-1,DEFAULT:0,COMPLETION:1,CONTENT:2},
    chat_completion_sources:{CLAUDE:'claude'},tool_reasoning_modes:{DISABLED:0},interleaved_reasoning_providers:[],
    isImageInliningSupported:()=>false,isVideoInliningSupported:()=>false,isAudioInliningSupported:()=>false,isReasoningSignatureSupported:()=>false,
    ToolManager:{canPerformToolCalls:()=>false,isToolCallingSupported:()=>false},
    tokenHandler:{countAsync:async message=>countCompatibilityMessagesSync([message],'gpt-4o',false)},
    oai_settings:readPromptManagerSettings({}),extension_prompts:json(extensions),traces,reads,MacroEngine,
  });
  vm.runInContext(original,ctx);
  const stores=createVariableStores(()=>ctx.chat_metadata.variables??={},()=>ctx.extension_settings.variables.global);
  const builder=new MacroEnvironmentBuilder(()=>({name1:ctx.name1,name2:ctx.name2,getGeneratingModel:()=> 'gpt-4o',
    getCharacterCardFieldsLazy:()=>vm.runInContext('getCharacterCardFieldsLazy()',ctx)}));
  builder.registerProvider(env=>Object.assign(env.extra,{model:env.system.model,variables:stores,readVariable:(key,global)=>stores[global?'global':'local'].get(key),
    parseMesExamples:text=>{ctx.exampleText=text;return vm.runInContext('parseMesExamples(exampleText,false)',ctx);},isInstruct:false}));
  ctx.MacroEnvBuilder=builder;
  vm.runInContext(`
    const subOriginal=substituteParams,readOriginal=getCharacterCardFields;
    getCharacterCardFields=function(...args){const before=structuredClone(chat_metadata.variables??{}),result=readOriginal(...args);reads.push({before,result,after:structuredClone(chat_metadata.variables??{})});return result;};
    substituteParams=function(...args){const before=structuredClone(chat_metadata.variables??{}),readStart=reads.length,result=subOriginal(...args);if(args[1]?.replaceCharacterCard!==false)traces.push({content:args[0],result,before,after:structuredClone(chat_metadata.variables??{}),cardReads:reads.length-readStart});return result;};
    promptManager=Object.create(PromptManager.prototype);promptManager.serviceSettings=oai_settings;promptManager.activeCharacter={id:100001};
  `,ctx);
  return ctx;
}
export function productCard(selected){return {id:randomUUID(),name:selected.name,description:selected.description??'',personality:selected.personality??'',scenario:selected.scenario??'',
  firstMessage:selected.first_mes??'',exampleDialogue:selected.mes_example??'',systemPrompt:selected.data?.system_prompt??'',postHistoryInstructions:selected.data?.post_history_instructions??'',
  creatorNotes:selected.data?.creator_notes??'',alternateGreetings:selected.data?.alternate_greetings??[],characterVersion:selected.data?.character_version??'',rawExtensions:selected.data?.extensions??{},
  lorebookEnabled:[],regexEnabled:[],tags:[],creator:'',sourceFormat:'ccv2-json',sourceVersion:'2.0',unknownFieldPaths:[],alternateGreetingsCount:0,lorebookEntries:[],regexScripts:[],lorebookEntryCount:0,regexScriptCount:0,deletedAt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
const runs=[];
for(const experimental of [false,true])for(const mode of ['public','native','normalized']){
  const selected=mode==='native'?card:mode==='normalized'?{name:card.name,description:'  DES\rCRIPTION\n\n\n\nTAIL {{incvar::descriptionRuns}}  ',personality:'',scenario:'ORIGINAL_SCENARIO{{incvar::originalScenario}}',
    mes_example:'ORIGINAL_EXAMPLE{{incvar::originalExample}}',first_mes:'Opening',data:{system_prompt:'ORIGINAL_SYSTEM{{incvar::originalSystem}}',post_history_instructions:'DISABLED_PHI{{incvar::disabledPhi}}',creator_notes:'',extensions:{depth_prompt:{prompt:''}},alternate_greetings:['DUPLICATE={{incvar::duplicateRuns}}','DUPLICATE={{incvar::duplicateRuns}}']}}:
    {name:'Macro API',description:'',personality:'',scenario:'',first_mes:'Hello',data:{}};
  const persona=mode==='native'?field('PERSONA','personaRuns'):mode==='normalized'?'':'PERSONA={{incvar::assembled}}/{{getvar::scanned}}';
  const powers={experimental_macro_engine:experimental,prefer_character_prompt:mode!=='normalized',prefer_character_jailbreak:mode!=='normalized',persona_description:persona,persona_description_position:0,collapse_newlines:mode==='normalized'};
  const product=productCard(selected),extensionSettings={__mycompanion_power_user:powers};
  let metadata={variables:{},chat_id_hash:1,...(mode==='normalized'?{system_prompt:'DISABLED_OVERRIDE{{incvar::disabledOverride}}',mes_example:'  OVERRIDE_EXAMPLE={{incvar::exampleRuns}}  ',scenario:'  OVERRIDE_SCENARIO={{incvar::scenarioRuns}}  '}:{})};
  const upstream=makeContext(selected,persona,experimental,metadata,{},powers);
  for(const round of mode==='native'?[1,2]:[1]){
    const traces=[],session=new MacroEvaluationSession(metadata,extensionSettings),originalEvaluate=session.evaluate.bind(session);
    session.evaluate=(text,context)=>{const before=json(session.local),result=originalEvaluate(text,context);if(context.replaceCharacterCard!==false)traces.push({content:text,result,before,after:json(session.local)});return result;};
    bindCharacterMacroEnvironment(product,metadata,extensionSettings,settings,session);
    let fields,wi='',matched='';
    if(mode!=='public'){
      fields=prepareCharacterMacroFields(characterWithChatOverrides(product,metadata),metadata,extensionSettings,settings,session);
      const expectedFields=vm.runInContext('getCharacterCardFields()',upstream);
      assert.deepEqual(json(fields),json(expectedFields),'first card differs');
      const keys=mode==='native'?['/D=\\d+\\/\\d+/']:['/DESCRIPTION\\nTAIL 1/','OVERRIDE_SCENARIO=1'];
      for(const key of keys){session.evaluate(key,{characterName:product.name,experimentalMacroEngine:experimental});upstream.keyText=key;vm.runInContext('substituteParams(keyText)',upstream);}
      const worldText=mode==='native'?world:'COUNTERS={{getvar::exampleRuns}}/{{getvar::descriptionRuns}}/{{getvar::scenarioRuns}}/{{getvar::duplicateRuns}}';
      wi=session.evaluate(worldText,{characterName:product.name,experimentalMacroEngine:experimental});
      upstream.worldText=worldText;assert.equal(wi,vm.runInContext('substituteParams(worldText)',upstream));
      const matchedText=mode==='native'?'MATCHED_DESCRIPTION={{getvar::descriptionRuns}}':'MATCHED_NORMALIZED_DESCRIPTION';
      matched=session.evaluate(matchedText,{characterName:product.name,experimentalMacroEngine:experimental});
      upstream.matchedText=matchedText;assert.equal(matched,vm.runInContext('substituteParams(matchedText)',upstream));
      if(mode==='normalized'){session.evaluate('MATCHED_OVERRIDE_SCENARIO',{characterName:product.name,experimentalMacroEngine:experimental});vm.runInContext("substituteParams('MATCHED_OVERRIDE_SCENARIO')",upstream);}
      upstream.fields=expectedFields;
      upstream.extension_prompts=expectedFields.charDepthPrompt?{DEPTH_PROMPT:{value:expectedFields.charDepthPrompt,position:1,depth:2,role:0,scan:false}}:{};
    }else{
      wi='WORLD=1/1'; upstream.chat_metadata.variables={scanned:1,...(!experimental?{assembled:1}:{})}; metadata.variables={...upstream.chat_metadata.variables};
      Object.assign(session.local,metadata.variables);
      upstream.fields={description:'',personality:'',scenario:'',system:'',jailbreak:'',mesExamples:''};
    }
    const history=[{role:'assistant',content:selected.first_mes,name:product.name},...(round===2?[{role:'assistant',content:'reply',name:product.name}]:mode==='public'?[{role:'user',content:'input',name:'User'}]:[])];
    const reportEntries=[{index:1,name:'world',status:'injected',matchedKey:null,tokens:0,diagnostics:[],content:wi,position:1,insertionOrder:100},
      ...(matched?[{index:2,name:'matched',status:'injected',matchedKey:null,tokens:0,diagnostics:[],content:matched,position:1,insertionOrder:100}]:[]),
      ...(mode==='normalized'?[{index:3,name:'scenario',status:'injected',matchedKey:null,tokens:0,diagnostics:[],content:'MATCHED_OVERRIDE_SCENARIO',position:1,insertionOrder:100}]:[])];
    const options={settings,character:product,history:history.map(message=>({...message,id:randomUUID(),conversationId:randomUUID(),branchId:randomUUID(),parentMessageId:null,status:'complete',createdAt:new Date().toISOString()})),
      memory:{conversationId:randomUUID(),results:[],block:'',position:'before_recent_messages',budgetTokens:500,injectedCount:0,durationMs:0},plugins:[],
      lorebook:{characterId:product.id,results:reportEntries,block:reportEntries.map(e=>e.content).join('\n\n'),constantBlock:'',position:'after_character_core',budgetTokens:500,injectedCount:reportEntries.length,durationMs:0},
      macroSession:session,extensionSettings,chatMetadata:metadata,prepareNativeCharacterFields:mode!=='public'};
    const actual=assembleModelPrompt(options);
    upstream.input={scenario:upstream.fields.scenario,charPersonality:upstream.fields.personality,charDescription:upstream.fields.description,worldInfoBefore:'',worldInfoAfter:reportEntries.map(e=>e.content).join('\n'),
      extensionPrompts:upstream.extension_prompts,systemPromptOverride:upstream.fields.system,jailbreakPromptOverride:upstream.fields.jailbreak,type:'normal'};
    const expected=await vm.runInContext(`(async()=>{const prompts=await preparePromptsForChatCompletion(input),completion=new ChatCompletion();completion.setTokenBudget(4096,128+512);
      const examples=parseMesExamples(fields.mesExamples,false).map(value=>parseExampleIntoIndividual(value));
      await populateChatCompletion(prompts,completion,{...input,messages:history.slice().reverse(),messageExamples:examples});return completion.getChat();})()`,Object.assign(upstream,{history}));
    assert.deepEqual(json(actual.messages),json(expected),`${mode}/${experimental}/${round} final messages`);
    assert.deepEqual(json(session.local),json(upstream.chat_metadata.variables),`${mode}/${experimental}/${round} variable effects`);
    const expectedTraces=upstream.traces.slice(runs.findLast(run=>run.mode===mode&&run.experimental===experimental)?.totalUpstreamTrace??0);
    assert.deepEqual(traces.map(call=>[call.content,call.result]),expectedTraces.map(call=>[call.content??'',call.result]),`${mode}/${experimental}/${round} independent substitution pass order`);
    runs.push({mode,experimental,round,passed:true,totalUpstreamTrace:upstream.traces.length,upstream:{messages:json(expected),variables:json(upstream.chat_metadata.variables),traces:json(expectedTraces),reads:json(upstream.reads)},product:{messages:json(actual.messages),variables:json(session.local),traces}});
    metadata={...metadata,variables:json(session.local)};
  }
}
for(const experimental of [false,true]){
  const selected={name:'Budget actor',description:'',personality:'',scenario:'',first_mes:'Hello',data:{}},product=productCard(selected);
  const extensionSettings={__mycompanion_power_user:{experimental_macro_engine:experimental}},metadata={variables:{},chat_id_hash:1};
  const upstream=makeContext(selected,'',experimental,metadata),session=new MacroEvaluationSession(metadata,extensionSettings),traces=[];
  const evaluate=session.evaluate.bind(session);session.evaluate=(text,context)=>{const result=evaluate(text,context);if(context.replaceCharacterCard!==false)traces.push({content:text,result});return result;};
  bindCharacterMacroEnvironment(product,metadata,extensionSettings,settings,session);
  const history=[{role:'user',content:'MUST_NOT_EVALUATE={{incvar::tooOld}}'},
    {role:'assistant',content:'REJECTED={{incvar::rejected}} '+ 'long '.repeat(2000)},
    {role:'user',content:'LATEST={{incvar::latest}}'}];
  const productSettings={...settings,contextLimitTokens:1024};
  const actual=assembleModelPrompt({settings:productSettings,character:product,history:history.map(message=>({...message,id:randomUUID(),conversationId:randomUUID(),branchId:randomUUID(),parentMessageId:null,status:'complete',createdAt:new Date().toISOString()})),
    memory:{conversationId:randomUUID(),results:[],block:'',position:'before_recent_messages',budgetTokens:500,injectedCount:0,durationMs:0},plugins:[],
    lorebook:{characterId:product.id,results:[],block:'',constantBlock:'',position:'after_character_core',budgetTokens:500,injectedCount:0,durationMs:0},
    macroSession:session,extensionSettings,chatMetadata:metadata,prepareNativeCharacterFields:false});
  upstream.history=history;upstream.input={scenario:'',charPersonality:'',charDescription:'',worldInfoBefore:'',worldInfoAfter:'',extensionPrompts:{},systemPromptOverride:'',jailbreakPromptOverride:'',type:'normal'};
  const expected=await vm.runInContext(`(async()=>{const prompts=await preparePromptsForChatCompletion(input),completion=new ChatCompletion();completion.setTokenBudget(1024,128+512);await populateChatCompletion(prompts,completion,{...input,messages:history.slice().reverse(),messageExamples:[]});return completion.getChat();})()`,upstream);
  assert.deepEqual(json(actual.messages),json(expected),'tight budget final messages');
  assert.deepEqual(json(session.local),json(upstream.chat_metadata.variables),'tight budget visited/rejected variable effects');
  assert.equal(session.local.latest,1);assert.equal(session.local.rejected,1);assert.equal(session.local.tooOld,undefined);
  assert.deepEqual(traces.map(call=>[call.content,call.result]),upstream.traces.map(call=>[call.content??'',call.result]),'tight budget substitution traversal order');
  runs.push({mode:'tight-budget',experimental,round:1,passed:true,upstream:{messages:json(expected),variables:json(upstream.chat_metadata.variables),traces:json(upstream.traces),reads:json(upstream.reads)},product:{messages:json(actual.messages),variables:json(session.local),traces}});
}
const target=reportUrl('prompt-population-upstream-oracle-20261002.json');
writeFileSync(target,JSON.stringify({passed:true,upstreamCommit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',sources:Object.fromEntries(files),
  scope:'Real unmodified upstream PromptManager, Message, MessageCollection, ChatCompletion and complete normal text population functions, with single-character/no-tools/no-media host bindings and the same tokenizer. Includes all-fit and tight-budget traversal (one rejected message prepared, older messages not visited). New macro engine uses lawful pinned shared interpreter/environment builder; host providers supply only variables and example formatter.',runs},null,2)+'\n');
console.log(JSON.stringify({passed:true,cases:runs.length,target:target.pathname}));



if(writeFixtures)writeFileSync(new URL('../../apps/local-service/src/fixtures/prompt-population-upstream-reference.json',import.meta.url),JSON.stringify({upstreamCommit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',oracle:'scripts/upstream-oracles/prompt-population-upstream-oracle-20261002.mjs',sources:Object.fromEntries(files),scope:'Single-character normal text PromptManager population; real unchanged legacy functions and pinned shared new engine with documented host bindings.',cases:runs.map(({mode,experimental,round,upstream})=>({mode,experimental,round,messages:upstream.messages,variables:upstream.variables}))},null,2)+'\n');

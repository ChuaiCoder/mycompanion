// SPDX-License-Identifier: AGPL-3.0-only
import { reportUrl, upstreamPublicUrl, writeFixtures } from './oracle-paths.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { source as macroSource, declarations, files } from './native-legacy-upstream-oracle-20261002.mjs';
import { PromptManager as AdaptedManager, readPromptManagerSettings, prepareCompletionPrompts } from '../../apps/local-service/dist/prompt-manager-core.js';

const upstreamSource = macroSource + '\nconst DEFAULT_ORDER=100, DEFAULT_DEPTH=4;\n' +
  declarations('scripts/PromptManager.js', ['Prompt', 'PromptCollection', 'PromptManager']) + '\n' +
  declarations('scripts/openai.js', ['formatWorldInfo', 'preparePromptsForChatCompletion', 'getPromptRole', 'getPromptPosition']) + '\n' +
  declarations('scripts/utils.js', ['stringFormat']);
const main = forbid_overrides => ({identifier:'main',role:'system',content:'MAIN={{incvar::mainRuns}}',system_prompt:true,forbid_overrides});
const marker = identifier => ({identifier,system_prompt:true,marker:true});
const custom = (identifier,content) => ({identifier,content,role:'system',system_prompt:false,injection_position:0});
const cases = [
  {name:'order-markers-custom',prompts:[main(false),custom('before','BEFORE={{incvar::beforeRuns}}'),marker('chatHistory'),custom('after','AFTER={{incvar::afterRuns}}')],order:[['before',true],['main',true],['chatHistory',true],['after',true]]},
  {name:'override-original',prompts:[main(false),marker('chatHistory')],order:[['main',true],['chatHistory',true]],systemPromptOverride:'OVERRIDE[{{original}}]/[{{original}}]'},
  {name:'forbidden-override',prompts:[main(true),marker('chatHistory')],order:[['main',true],['chatHistory',true]],systemPromptOverride:'SHOULD_NOT_RUN={{incvar::overrideRuns}}'},
  {name:'disabled-main-trigger',prompts:[main(false),{...custom('quiet-only','SHOULD_NOT_RUN={{incvar::quietRuns}}'),injection_trigger:['quiet']},marker('chatHistory')],order:[['main',false],['quiet-only',true],['chatHistory',true]]},
  {name:'world-format-and-persona',prompts:[main(false),marker('worldInfoBefore'),marker('personaDescription'),marker('chatHistory')],order:[['main',true],['worldInfoBefore',true],['personaDescription',true],['chatHistory',true]],worldInfoBefore:'WI={{incvar::wiRuns}}',personaDescription:'PERSONA={{incvar::personaRuns}}',wi_format:'FMT[{0}]'},
  {name:'format-field-pass',prompts:[main(false),marker('scenario'),marker('charPersonality'),marker('chatHistory')],order:[['main',true],['scenario',true],['charPersonality',true],['chatHistory',true]],scenario_format:'S[{{scenario}}]',personality_format:'P[{{personality}}]'},
];
const json = value => JSON.parse(JSON.stringify(value));
function contextFor(settings, persona) {
  const traces=[], reads=[];
  const context = vm.createContext({console,structuredClone,uuidv4:randomUUID,
    characters:[{name:'Oracle actor',description:'DESC',personality:'PERSONALITY',scenario:'SCENARIO',first_mes:'Hello',data:{}}],this_chid:0,
    selected_group:null,groups:[],name1:'User',name2:'Oracle actor',main_api:'openai',chat:[],chat_metadata:{variables:{},chat_id_hash:1},
    extension_settings:{variables:{global:{}}},accountStorage:{getItem:()=> 'true'},getGeneratingModel:()=> 'gpt-4o',getInstructMacros:()=>[],
    saveMetadataDebounced:()=>{},saveSettingsDebounced:()=>{},
    power_user:{experimental_macro_engine:false,prefer_character_prompt:true,prefer_character_jailbreak:true,persona_description:persona??'',persona_description_position:0,collapse_newlines:false,instruct:{enabled:false},context:{example_separator:''}},
    persona_description_positions:{IN_PROMPT:0},extension_prompt_types:{IN_PROMPT:0,IN_CHAT:1,BEFORE_PROMPT:2,NONE:-1},extension_prompt_roles:{SYSTEM:0,USER:1,ASSISTANT:2},
    oai_settings:structuredClone(settings),traces,reads,
  });
  vm.runInContext(upstreamSource,context);
  vm.runInContext(`
    const subOriginal=substituteParams,cardOriginal=getCharacterCardFields;
    getCharacterCardFields=function(...args){const before=structuredClone(chat_metadata.variables),result=cardOriginal(...args);reads.push({before,result,after:structuredClone(chat_metadata.variables)});return result;};
    substituteParams=function(...args){const before=structuredClone(chat_metadata.variables),readStart=reads.length,result=subOriginal(...args);traces.push({content:args[0],options:args[1],result,before,after:structuredClone(chat_metadata.variables),cardReads:reads.length-readStart});return result;};
    promptManager=Object.create(PromptManager.prototype);promptManager.serviceSettings=oai_settings;promptManager.activeCharacter={id:100001};
  `,context);
  return context;
}
const runs=[];
for(const fixture of cases){
  const rawSettings={prompts:fixture.prompts,prompt_order:[{character_id:100001,order:fixture.order.map(([identifier,enabled])=>({identifier,enabled}))}],wi_format:fixture.wi_format??'',scenario_format:fixture.scenario_format??'',personality_format:fixture.personality_format??'',group_nudge_prompt:'',impersonation_prompt:''};
  const settings=readPromptManagerSettings({__mycompanion_openai:{settings:rawSettings}});
  const sources={charDescription:'DESC',charPersonality:'PERSONALITY',scenario:'SCENARIO',worldInfoBefore:fixture.worldInfoBefore??'',worldInfoAfter:'',personaDescription:fixture.personaDescription??'',systemPromptOverride:fixture.systemPromptOverride??'',jailbreakPromptOverride:'',extensions:[{key:'relative',value:'EXT={{incvar::extensionRuns}}',position:0,role:0}]};
  const upstream=contextFor(settings,sources.personaDescription),adapted=contextFor(settings,sources.personaDescription);
  upstream.input={...sources,extensionPrompts:Object.fromEntries(sources.extensions.map(prompt=>[prompt.key,prompt])),type:'normal'};
  const expected=await vm.runInContext('preparePromptsForChatCompletion(input)',upstream);
  const manager=new AdaptedManager(structuredClone(settings),(content,original)=>{
    adapted.text=content;adapted.options=typeof original==='string'?{original}:{};
    return vm.runInContext('substituteParams(text,options)',adapted);
  });
  const actual=prepareCompletionPrompts(manager,sources);
  assert.deepEqual(json(actual),json(expected),fixture.name+' prepared prompts differ from real upstream functions');
  assert.deepEqual(json(adapted.chat_metadata.variables),json(upstream.chat_metadata.variables),fixture.name+' variable effects differ');
  assert.deepEqual(json(adapted.traces).map(item=>[item.content,item.result,item.cardReads]),json(upstream.traces).map(item=>[item.content,item.result,item.cardReads]),fixture.name+' substitution pass sequence differs');
  runs.push({name:fixture.name,settings,sources,upstream:{prompts:json(expected),variables:json(upstream.chat_metadata.variables),traces:json(upstream.traces),cardReads:json(upstream.reads)},adapted:{prompts:json(actual),variables:json(adapted.chat_metadata.variables),traces:json(adapted.traces),cardReads:json(adapted.reads)}});
}
const target=reportUrl('prompt-manager-upstream-oracle-20261002.json');
writeFileSync(target,JSON.stringify({passed:true,upstreamCommit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',sources:Object.fromEntries(files),scope:'Real unmodified upstream PromptManager preparation and merging functions. Compare every macro pass, output and draft variable state; this does not yet validate tools/multimodal/full transport.',runs},null,2)+'\n');
console.log(JSON.stringify({passed:true,cases:runs.length,target:target.pathname}));

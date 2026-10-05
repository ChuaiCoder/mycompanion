// SPDX-License-Identifier: AGPL-3.0-only
import { reportUrl, upstreamPublicUrl, writeFixtures } from './oracle-paths.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeContext, productCard } from './prompt-population-upstream-oracle-20261002.mjs';
import { assembleModelPrompt } from '../../apps/local-service/dist/providers/model-client.js';
import { MacroEvaluationSession } from '../../apps/local-service/dist/prompt/prompt-macros.js';
import { bindCharacterMacroEnvironment } from '../../apps/local-service/dist/character/character-macros.js';
const json=value=>JSON.parse(JSON.stringify(value)),runs=[];
const settings={kind:'ollama',baseUrl:'http://provider.test/v1',model:'gpt-4o',maxTokens:128,contextLimitTokens:4096,temperature:0.7,hasApiKey:false};
for(const experimental of [false,true])for(const mode of ['public-single','public-readonly','extension-residual']){
  const selected={name:'Macro API',description:'',personality:'',scenario:'',first_mes:'Hello',data:{}};
  const persona=mode==='extension-residual'?'':'PERSONA={{incvar::assembled}}/{{getvar::scanned}}';
  const metadata={variables:mode==='public-single'?{scanned:1,...(!experimental?{assembled:1}:{})}:mode==='extension-residual'?{inner:'SECOND'}:{},chat_id_hash:1};
  const extension=mode==='extension-residual'?{residual:{value:'{{getvar::inner}}',position:0,depth:0,role:0,scan:false}}:{};
  const upstream=makeContext(selected,persona,experimental,metadata,extension),character=productCard(selected);
  const extensionSettings={__mycompanion_power_user:{experimental_macro_engine:experimental,persona_description:persona,persona_description_position:0}};
  const session=new MacroEvaluationSession(metadata,extensionSettings),traces=[];
  const evaluate=session.evaluate.bind(session);session.evaluate=(text,context)=>{const result=evaluate(text,context);if(context.replaceCharacterCard!==false)traces.push({content:text,result});return result;};
  bindCharacterMacroEnvironment(character,metadata,extensionSettings,settings,session);
  const wi=mode==='public-single'?'WORLD=1/1':'';
  const actual=assembleModelPrompt({settings,character,history:[{id:randomUUID(),conversationId:randomUUID(),branchId:randomUUID(),parentMessageId:null,role:'user',content:'input',status:'complete',createdAt:new Date().toISOString()}],
    memory:{conversationId:randomUUID(),results:[],block:'',position:'before_recent_messages',budgetTokens:500,injectedCount:0,durationMs:0},plugins:[],
    lorebook:{characterId:character.id,results:wi?[{index:1,name:'world',status:'injected',matchedKey:null,tokens:0,diagnostics:[],content:wi,position:1}]:[],block:wi,constantBlock:'',position:'after_character_core',budgetTokens:500,injectedCount:0,durationMs:0},
    macroSession:session,extensionSettings,chatMetadata:metadata,prepareNativeCharacterFields:false,
    extensionPrompts:Object.entries(extension).map(([key,value])=>({key,...value,macrosResolved:true}))});
  upstream.history=[{role:'user',content:'input'}];upstream.input={scenario:'',charPersonality:'',charDescription:'',worldInfoBefore:'',worldInfoAfter:wi,extensionPrompts:extension,systemPromptOverride:'',jailbreakPromptOverride:'',type:'normal'};
  const expected=await vm.runInContext(`(async()=>{const prompts=await preparePromptsForChatCompletion(input),completion=new ChatCompletion();completion.setTokenBudget(4096,128+512);await populateChatCompletion(prompts,completion,{...input,messages:history.slice().reverse(),messageExamples:[]});return completion.getChat();})()`,upstream);
  assert.deepEqual(json(actual.messages),json(expected),mode+' messages');assert.deepEqual(json(session.local),json(upstream.chat_metadata.variables),mode+' variables');
  assert.deepEqual(traces.map(call=>[call.content,call.result]),upstream.traces.map(call=>[call.content??'',call.result]),mode+' per-call trace');
  runs.push({mode,experimental,passed:true,upstream:{messages:json(expected),variables:json(upstream.chat_metadata.variables),traces:json(upstream.traces),reads:json(upstream.reads)},product:{messages:json(actual.messages),variables:json(session.local),traces}});
}
writeFileSync(reportUrl('prompt-lifecycle-upstream-oracle-20261002.json'),JSON.stringify({passed:true,upstreamCommit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',runs},null,2)+'\n');
if(writeFixtures)writeFileSync(new URL('../../apps/local-service/src/fixtures/prompt-lifecycle-upstream-reference.json',import.meta.url),JSON.stringify({upstreamCommit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',oracle:'scripts/upstream-oracles/prompt-lifecycle-upstream-oracle-20261002.mjs',runs:runs.map(({mode,experimental,upstream})=>({mode,experimental,messages:upstream.messages,variables:upstream.variables}))},null,2)+'\n');
console.log(JSON.stringify({passed:true,cases:runs.length}));

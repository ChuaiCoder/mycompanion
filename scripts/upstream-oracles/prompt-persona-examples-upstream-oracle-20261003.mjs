// SPDX-License-Identifier: AGPL-3.0-only
import { reportUrl, upstreamPublicUrl, writeFixtures } from './oracle-paths.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync,writeFileSync } from 'node:fs';
import { makeContext } from './prompt-population-upstream-oracle-20261002.mjs';
import { declarations } from './native-legacy-upstream-oracle-20261002.mjs';
const json=value=>JSON.parse(JSON.stringify(value)),runs=[];
const script=readFileSync(new URL('script.js',upstreamPublicUrl),'utf8');
{
  const context=makeContext({name:'Astronomer',data:{}},'LEGACY_PERSONA',false,{});
  const dom={text(){return this;},toggle(){return this;},val(){return this;},find(){return this;},attr(){return this;},prop(){return this;},toggleClass(){return this;}};
  Object.assign(context,{$:()=>dom,DEFAULT_DEPTH:2,countPersonaDescriptionTokens:()=>{},updatePersonaUIStates:()=>{},updatePersonaConnectionsAvatarList:()=>{},
    persona_description_positions:{IN_PROMPT:0,AFTER_CHAR:1,TOP_AN:2,BOTTOM_AN:3,AT_DEPTH:4,NONE:9}});
  context.power_user.persona_description_position=1;
  vm.runInContext(declarations('scripts/personas.js',['setPersonaDescription']),context);
  vm.runInContext('setPersonaDescription()',context);
  assert.equal(context.power_user.persona_description_position,0);
  runs.push({mode:'legacy-persona-position',before:1,after:context.power_user.persona_description_position});
}
for(const note of ['EXPLICIT_NOTE','PERSONA_TEXT\nEXPLICIT_NOTE']){
  const context=makeContext({name:'Astronomer',data:{}},'PERSONA_TEXT',false,{});
  Object.assign(context,{NOTE_MODULE_NAME:'2_floating_prompt',shouldWIAddPrompt:true,metadata_keys:{position:'note_position',depth:'note_depth',role:'note_role'},persona_description_positions:{NONE:9,IN_PROMPT:0,TOP_AN:2,BOTTOM_AN:3,AT_DEPTH:4},setExtensionPrompt:(key,value,position,depth,scan,role)=>{context.extension_prompts[key]={value,position,depth,scan,role};}});
  context.extension_settings.note={allowWIScan:false};context.chat_metadata={note_position:1,note_depth:0,note_role:0};context.power_user.persona_description_position=2;
  context.extension_prompts['2_floating_prompt']={value:note,position:1,depth:0,role:0};
  vm.runInContext(declarations('script.js',['addPersonaDescriptionExtensionPrompt']),context);
  vm.runInContext('addPersonaDescriptionExtensionPrompt()',context);
  const result=context.extension_prompts['2_floating_prompt'].value;
  assert.equal(result,'PERSONA_TEXT\n'+note);
  runs.push({mode:'persona-author-note',note,result});
}
const start=script.indexOf('    for (const example of worldInfoExamples) {'),end=script.indexOf('    // At this point, the raw message examples',start);
assert(start>0&&end>start);const originalLoop=script.slice(start,end);
for(const experimental of [false,true]){
  const context=makeContext({name:'Astronomer',description:'',personality:'',scenario:'',mes_example:'',first_mes:'',data:{extensions:{depth_prompt:{prompt:''}}}},'',experimental,{variables:{},chat_id_hash:1});
  context.worldInfoExamples=[{content:'<START>\nAstronomer: TOP={{incvar::exampleRuns}}',position:0},{content:'<START>\nAstronomer: BOTTOM={{incvar::exampleRuns}}',position:1}];
  context.mesExamplesArray=['<START>\nAstronomer: ORIGINAL\n'];context.isInstruct=false;context.wi_anchor_position={before:0,after:1};
  vm.runInContext(originalLoop,context);
  const examples=context.mesExamplesArray.map(text=>{context.text=text;return json(vm.runInContext('parseExampleIntoIndividual(text)',context));});
  assert.deepEqual(examples.map(block=>block[0].content),['TOP=1','ORIGINAL','BOTTOM=2']);
  runs.push({mode:'world-info-examples',experimental,examples,variables:json(context.chat_metadata.variables),traces:json(context.traces)});
}
writeFileSync(reportUrl('prompt-persona-examples-upstream-oracle-20261003.json'),JSON.stringify({passed:true,upstreamCommit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',sourceLoop:originalLoop,runs},null,2)+'\n');
if(writeFixtures)writeFileSync(new URL('../../apps/local-service/src/fixtures/prompt-persona-examples-upstream-reference.json',import.meta.url),JSON.stringify({upstreamCommit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',oracle:'scripts/upstream-oracles/prompt-persona-examples-upstream-oracle-20261003.mjs',runs},null,2)+'\n');
console.log(JSON.stringify({passed:true,cases:runs.length}));


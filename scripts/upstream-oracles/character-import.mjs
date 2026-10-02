// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { parse } from 'acorn';
import lodash from 'lodash';
import yaml from 'yaml';
const { values } = parseArgs({ options: { 'upstream-dir': {type:'string'}, 'report-dir':{type:'string'}, 'write-fixtures':{type:'boolean',default:false} } });
const commit='7e8663cd9c184a550b37238218bdd32c6efc68e9';
const upstream=resolve(values['upstream-dir']??`.cache/research/SillyTavern-${commit}`);
const characters=await readFile(resolve(upstream,'src/endpoints/characters.js'),'utf8');
const byaf=await readFile(resolve(upstream,'src/byaf.js'),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
assert.equal(hash(characters),'3235555529e9ff17ecc2ebe9168b0af77fe6ef5947f3d1f7de3df6d5f2567d89');
assert.equal(hash(byaf),'dc056d1b7f9d616e08b8b49e3db1150cd824665bd1e041ed79ef86ec417765dc');
const wanted=['convertToV2','charaFormatData','importFromJson','importFromYaml'];
const declarations=parse(characters,{ecmaVersion:'latest',sourceType:'module'}).body;
const extracted=wanted.map(name=>{
  const declaration=declarations.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name);
  assert(declaration,'Missing actual upstream function '+name);return characters.slice(declaration.start,declaration.end);
}).join('\n');
let uploaded='',written;
const sandbox={_,console:{info(){},warn(){}},JSON,Date,yaml,DEFAULT_AVATAR_PATH:'own-oracle-avatar',
  fs:{readFileSync:()=>uploaded,unlinkSync(){}},sanitize:value=>value,humanizedDateTime:()=> 'oracle-date',
  getPngName:name=>name,tryParse:value=>{try{return JSON.parse(value);}catch{return null;}},
  writeCharacterData:async(_avatar,data)=>{written=JSON.parse(data);return true;},
  deepMerge:lodash.merge,readWorldInfoFile:()=>null};
function _(...args){return lodash(...args);}
Object.assign(_,lodash);
vm.createContext(sandbox);
vm.runInContext(extracted+'\nglobalThis.importJson=importFromJson;globalThis.importYaml=importFromYaml;',sandbox);
vm.runInContext(byaf.replace(/^import .*\r?\n/gm,'').replace('export class ByafParser','class ByafParser').replace(/^export default ByafParser;?\s*$/m,'')+'\nglobalThis.Byaf=ByafParser;',sandbox);
const context={request:{user:{directories:{}}}};
const cases=[];
const coreKeys=['name','description','personality','scenario','first_mes','mes_example','creator_notes','tags','creator'];
const core=data=>Object.fromEntries(coreKeys.map(key=>[key,data[key]]));
for(const [name,input] of [
  ['v1',{name:'Legacy Cartographer',description:'A keeper',personality:'Quiet',scenario:'Harbor',first_mes:'Hello',mes_example:'<START>\nKeeper: Hi',creator_notes:'Notes',tags:'map, harbor',creator:'Fixture',foreign:{retained:true}}],
  ['v1-missing',{name:'Minimal'}],
  ['pygmalion',{char_name:'Pygmalion',char_persona:'A guide',world_scenario:'Port',char_greeting:'Welcome',example_dialogue:'User: Hi',tags:['legacy'],creator:'Fixture',foreign:{retained:true}}],
]){
  uploaded=JSON.stringify(input);written=undefined;await sandbox.importJson('uploaded',context);
  cases.push({name,input,expectedCore:core(written.data)});
}
const yamlInput='name: YAML Guide\ncontext: A harbor guide\ngreeting: Welcome\nforeign:\n  retained: true\n';
uploaded=yamlInput;await sandbox.importYaml('uploaded',context);
cases.push({name:'yaml',input:yamlInput,expectedCore:core(written.data)});
const date='2025-06-13T12:00:00.000Z';
const manifest={author:{name:'Fixture',backyardURL:'https://example.com/author'}};
const character={name:'BYAF Guide',persona:'{character} remembers {user}',displayName:'The Guide',loreItems:[{key:'port, harbor',value:'Home of {character}'}]};
const scenario={narrative:'Harbor {character}',formattingInstructions:'Become {character}',firstMessages:[{text:'Greeting'}],exampleMessages:[{text:'#{character}: Hi'}],messages:[
  {type:'human',createdAt:String(Date.parse(date)),text:'Where?'},
  {type:'ai',outputs:[{createdAt:String(Date.parse(date)),activeTimestamp:date,text:'Old'},{createdAt:String(Date.parse(date)),activeTimestamp:'2025-06-13T12:01:00.000Z',text:'New'}]}]};
const parser=new sandbox.Byaf(new Map());
const byafCard=JSON.parse(JSON.stringify(parser.getCharacterCard(manifest,character,[scenario,{firstMessages:[{text:'Alternative'}]}])));
cases.push({name:'byaf-card',input:{manifest,character,scenarios:[scenario,{firstMessages:[{text:'Alternative'}]}]},expectedCore:core(byafCard.data),
  alternateGreetings:byafCard.data.alternate_greetings,characterBook:byafCard.data.character_book,systemPrompt:byafCard.data.system_prompt});
const chat=JSON.parse('['+sandbox.Byaf.getChatFromScenario(scenario,'User',character.name,[]).split('\n').join(',')+']');
cases.push({name:'byaf-chat',input:scenario,expectedMessages:chat.slice(1).map(message=>({role:message.is_user?'user':'assistant',content:message.mes,
  ...(message.swipes?{swipes:message.swipes,swipeId:message.swipe_id}: {})}))});
let aiOnlyError;
try{sandbox.Byaf.getChatFromScenario({...scenario,messages:[scenario.messages[1]]},'User',character.name,[]);}catch(error){aiOnlyError=String(error);}
assert(aiOnlyError,'Pinned upstream AI-only failure changed');
const reference={meta:{repository:'https://github.com/SillyTavern/SillyTavern',commit,license:'AGPL-3.0-only',
  oracle:'scripts/upstream-oracles/character-import.mjs',sourceHashes:{'src/endpoints/characters.js':hash(characters),'src/byaf.js':hash(byaf)},
  hostStubs:['File read/write and avatar storage; no copied application server.','Filesystem-safe test names and deterministic date label.'],
  intentionalDifferences:['Preserve foreign fields discarded by legacy/YAML upstream import.','Keep display names; UUID storage replaces filename sanitization.',
    'Preserve explicit legacy advanced fields; upstream V1 import discards them.','BYAF ISO dates remain valid; AI-only histories import instead of upstream TypeError.',
    'BYAF card/assets/scenarios use one SQLite transaction; original archive JSON remains byte-identical.'],
  knownUpstreamAiOnlyError:aiOnlyError},cases};
const fixture=resolve('apps/local-service/src/fixtures/character-import-upstream-reference.json');
if(values['write-fixtures'])await writeFile(fixture,JSON.stringify(reference,null,2)+'\n');
else assert.deepEqual(JSON.parse(await readFile(fixture,'utf8')),reference,'Reference changed; inspect before --write-fixtures');
const reportDir=resolve(values['report-dir']??'.cache/reports');await mkdir(reportDir,{recursive:true});
const reportPath=resolve(reportDir,'character-import-upstream-oracle-'+new Date().toISOString().replace(/[:.]/g,'')+'.json');
await writeFile(reportPath,JSON.stringify({passed:true,checkedAt:new Date().toISOString(),upstreamCommit:commit,fixtureSha256:hash(await readFile(fixture)),caseCount:cases.length,knownUpstreamAiOnlyError:aiOnlyError},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:true,caseCount:cases.length,reportPath}));

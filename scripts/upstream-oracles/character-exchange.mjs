// SPDX-License-Identifier: AGPL-3.0-only
// Build the service first, then run: node scripts/upstream-oracles/character-exchange.mjs
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import path from 'node:path';
import { parseArgs } from 'node:util';
import vm from 'node:vm';
import { parse } from 'acorn';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import yauzl from 'yauzl';
import sanitize from 'sanitize-filename';
import lodash from 'lodash';
import { ZipFile } from 'yazl';
import { buildApp } from '../../apps/local-service/dist/app.js';
import { parseCharacterArchive } from '../../apps/local-service/dist/character-archive.js';
import { encodeCharacterCardPng,parseCharacterCardDocument,parseCharacterCardPngDocument } from '@mycompanion/character-card';

const {values}=parseArgs({options:{'upstream-dir':{type:'string'},'report-dir':{type:'string'}}});
const commit='7e8663cd9c184a550b37238218bdd32c6efc68e9';
const upstream=path.resolve(values['upstream-dir']??`.cache/research/SillyTavern-${commit}`);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sources={};
for(const [file,sha256] of Object.entries({
  'src/character-card-parser.js':'b74541cd54bb3fe3ab39b3e040f6dba824b263ed9344e4dcf98363e4e148e07c',
  'src/png/encode.js':'bde45d94ca4750fbfd7979620547adb5b057e38000687af57f9dd0654f212904',
  'src/charx.js':'92e0045ff69691057cca55b7514f2bdd3615cf5ab35bf11be3231709669e6680',
  'src/util.js':'d33d67234af4e188bb7fcfac9c3ca7952c19e8c58791e96b19f9ad748dd168cd',
})) {
  const source=await readFile(path.join(upstream,file),'utf8');assert.equal(hash(source),sha256,'Upstream source changed: '+file);sources[file]=source;
}
function declarations(source,wanted){
  return parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.flatMap(node=>{
    const declaration=node.type==='ExportNamedDeclaration'||node.type==='ExportDefaultDeclaration' ? node.declaration : node;
    const names=declaration?.id?.name ? [declaration.id.name] : declaration?.declarations?.map(item=>item.id.name)??[];
    return names.some(name=>wanted.includes(name)) ? [source.slice(declaration.start,declaration.end)] : [];
  }).join('\n');
}
const sandbox={Buffer,Uint8Array,Int32Array,Uint32Array,Map,Set,JSON,path,extract,PNGtext,yauzl,sanitize,crc32,_:lodash,
  DEFAULT_AVATAR_PATH:'own-fixture-avatar',console:{info(){},warn(){},error(){}}};
vm.createContext(sandbox);
vm.runInContext(declarations(sources['src/png/encode.js'],['encode'])+'\nglobalThis.encode=encode;',sandbox);
vm.runInContext(declarations(sources['src/character-card-parser.js'],['read','write'])+'\nglobalThis.readCard=read;globalThis.writeCard=write;',sandbox);
vm.runInContext(declarations(sources['src/util.js'],['extractFileFromZipBuffer','normalizeZipEntryPath','extractFilesFromZipBuffer']),sandbox);
vm.runInContext(declarations(sources['src/charx.js'],['CHARX_EMBEDDED_URI_PREFIXES','CHARX_IMAGE_EXTENSIONS','CHARX_SPRITE_TYPES','CHARX_BACKGROUND_TYPES','ZIP_SIGNATURE','findZipStart','CharXParser'])+'\nglobalThis.CharX=CharXParser;',sandbox);
async function archive(card,assets){
  const zip=new ZipFile(),chunks=[];
  const done=new Promise((resolve,reject)=>{zip.outputStream.on('data',part=>chunks.push(part));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.on('error',reject);});
  zip.addBuffer(Buffer.from(JSON.stringify(card)),'card.json');
  for(const [name,bytes] of assets)zip.addBuffer(bytes,name);
  zip.end();return done;
}
const fixture=JSON.parse(await readFile('packages/character-card/fixtures/ccv2-full.json','utf8'));
const portrait=Buffer.from(encodeCharacterCardPng(parseCharacterCardDocument(fixture).card));
const audio=Buffer.from('RIFF\x01\x02\x03\x04','binary');
const raw={...structuredClone(fixture),spec:'chara_card_v3',spec_version:'3.0',foreignTop:{exchange:'retained'},data:{...structuredClone(fixture.data),foreignData:{retained:true},
  assets:[{type:'icon',name:'main',ext:'png',uri:'__asset:assets/main.png'},{type:'emotion',name:'happy',ext:'png',uri:'embeded://assets/happy.png'},
    {type:'audio',name:'greeting',ext:'wav',uri:'embedded://assets/greeting.wav'}]}};
const assets=new Map([['assets/main.png',portrait],['assets/happy.png',portrait],['assets/greeting.wav',audio],['arbitrary.txt',Buffer.from('unreferenced auxiliary file')]]);
const report={passed:false,checkedAt:new Date().toISOString(),upstreamCommit:commit,sourceHashes:Object.fromEntries(Object.entries(sources).map(([name,source])=>[name,hash(source)])),
  hostBindings:['Original PNG/CHARX/ZIP function/class declaration bodies unchanged; actual yauzl and png library IO.','Node built-in crc32 compatible primitive replaces the upstream crc npm import.','Isolated self-authored card/portrait/archive; actual MyCompanion loopback HTTP. No upstream full application or user data.'],stages:[],limitations:['This runs exact upstream parser/exporter declarations, not the complete upstream UI/server.','Upstream CHARX only selects image auxiliary assets; audio and arbitrary assets are preserved by MyCompanion but not promoted to upstream storage.','Final EXE/V5.3 live card remains a separate C01/G02 requirement.']};
report.compiledInputHashes=Object.fromEntries(await Promise.all(['app','character-routes','character-archive'].map(async name=>[name+'.js',hash(await readFile('apps/local-service/dist/'+name+'.js'))])));
const app=buildApp(),target=buildApp();
const stage=(name,details={})=>report.stages.push({name,passed:true,...details});
try {
  const address=await app.listen({host:'127.0.0.1',port:0});
  const request=async(url,body,mime)=>{
    const response=await fetch(address+url,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':mime??'application/json'},body:mime?body:JSON.stringify(body)})});
    const bytes=Buffer.from(await response.arrayBuffer());assert(response.ok,`${url} returned ${response.status}: ${bytes.toString()}`);
    return {bytes,json:()=>JSON.parse(bytes.toString())};
  };
  const upstreamPng=sandbox.writeCard(portrait,JSON.stringify(raw));
  assert.deepEqual(JSON.parse(sandbox.readCard(upstreamPng)),raw);stage('genuine-upstream-png-write-and-read',{sha256:hash(upstreamPng)});
  const missingAssets=await fetch(address+'/api/characters/import/commit',{method:'POST',headers:{'Content-Type':'image/png'},body:upstreamPng});
  assert.equal(missingAssets.status,422);assert.equal((await missingAssets.json()).error.code,'INVALID_CHARACTER_CARD');
  stage('upstream-writer-missing-referenced-assets-explicitly-rejected');
  const plainCard=structuredClone(raw);delete plainCard.data.assets;
  const validUpstreamPng=sandbox.writeCard(portrait,JSON.stringify(plainCard));
  const fromST=(await request('/api/characters/import/commit',validUpstreamPng,'image/png')).json();
  const stExport=(await request(`/api/characters/${fromST.id}/export?format=json`)).json();
  assert.deepEqual(stExport.foreignTop,raw.foreignTop);assert.deepEqual(stExport.data.foreignData,raw.data.foreignData);
  for(const key of ['name','description','personality','scenario','first_mes','mes_example','character_book'])assert.deepEqual(stExport.data[key],raw.data[key]);
  stage('upstream-png-to-mycompanion-real-http');
  const importedArchive=(await request('/api/characters/import/commit',await archive(raw,assets),'application/charx')).json();
  const myPNG=(await request(`/api/characters/${importedArchive.id}/export?format=png`)).bytes;
  const upstreamReads=JSON.parse(sandbox.readCard(myPNG));assert.deepEqual(upstreamReads.foreignTop,raw.foreignTop);assert.deepEqual(upstreamReads.data.foreignData,raw.data.foreignData);
  stage('mycompanion-png-to-genuine-upstream-read',{sha256:hash(myPNG)});
  const writtenAgain=sandbox.writeCard(myPNG,JSON.stringify(upstreamReads));
  const reparsed=parseCharacterCardPngDocument(writtenAgain);assert.deepEqual(reparsed.assets,assets);
  const again=(await request('/api/characters/import/commit',writtenAgain,'image/png')).json();
  const againArchive=(await request(`/api/characters/${again.id}/export?format=charx`)).bytes;
  assert.deepEqual((await parseCharacterArchive(againArchive)).assets,assets);
  stage('upstream-rewrite-preserves-png-assets-back-to-mycompanion',{sha256:hash(writtenAgain),assets:assets.size});
  const myArchive=(await request(`/api/characters/${importedArchive.id}/export?format=charx`)).bytes;
  const myJson=(await request(`/api/characters/${importedArchive.id}/export?format=json`)).json();
  const stParsed=await new sandbox.CharX(myArchive).parse();assert.deepEqual(stParsed.card,myJson);assert.deepEqual(stParsed.avatar,portrait);
  assert.deepEqual(stParsed.extractedBuffers.get('assets/happy.png'),portrait);assert.equal(stParsed.auxiliaryAssets.length,1);assert.equal(stParsed.auxiliaryAssets[0].storageCategory,'sprite');
  stage('mycompanion-charx-through-genuine-upstream-zip-parser',{sha256:hash(myArchive),upstreamSelectedImages:stParsed.extractedBuffers.size});
  const fromSTCard=structuredClone(stParsed.card);fromSTCard.data.foreignData.upstreamRoundTrip='retained';
  const packedBack=await archive(fromSTCard,assets);
  const fromSTArchive=(await request('/api/characters/import/commit',packedBack,'application/charx')).json();
  const roundTrip=(await parseCharacterArchive((await request(`/api/characters/${fromSTArchive.id}/export?format=charx`)).bytes));
  assert.deepEqual(roundTrip.card.data.foreignData,{retained:true,upstreamRoundTrip:'retained'});assert.deepEqual(roundTrip.assets,assets);
  stage('genuine-upstream-charx-card-back-to-mycompanion-byte-exact-assets');
  const backup=(await request('/api/backup')).json();
  const restored=await target.inject({method:'POST',url:'/api/backup/restore',payload:{backup,strategy:'overwrite'}});assert.equal(restored.statusCode,200,restored.body);
  const restoredArchive=await target.inject({method:'GET',url:`/api/characters/${fromSTArchive.id}/export?format=charx`});
  assert.deepEqual((await parseCharacterArchive(restoredArchive.rawPayload)).assets,assets);
  stage('full-backup-keeps-upstream-exchanged-assets');
  report.passed=true;
} catch(error){report.error=String(error.stack??error);process.exitCode=1;}
finally {
  await app.close();await target.close();
  const reportDir=path.resolve(values['report-dir']??'.cache/reports');await mkdir(reportDir,{recursive:true});
  const output=path.join(reportDir,'character-exchange-upstream-'+report.checkedAt.replace(/[^0-9TZ]/g,'')+'.json');
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:report.passed,stages:report.stages.length,output,error:report.error},null,2));
}

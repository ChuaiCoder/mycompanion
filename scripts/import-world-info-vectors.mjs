// Reuse the pinned AGPL world-vector orchestration and global top-K algorithm.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
const commit='7e8663cd9c184a550b37238218bdd32c6efc68e9',root=resolve(process.argv[2]??`.cache/research/SillyTavern-${commit}`);
const clientPath='public/scripts/extensions/vectors/index.js',serverPath='src/endpoints/vectors.js';
const client=readFileSync(join(root,clientPath),'utf8'),server=readFileSync(join(root,serverPath),'utf8');
function extract(source,name){const node=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.map(item=>item.type==='ExportNamedDeclaration'?item.declaration:item)
  .find(item=>item?.id?.name===name);if(!node)throw new Error(`Missing fixed vector declaration ${name}`);return source.slice(node.start,node.end);}
const query=extract(client,'getQueryText');
const activate=extract(client,'activateWorldInfo').replace("const queryText = await getQueryText(chat, 'world-info');","const queryText = deps.queryText ?? await getQueryText(chat, 'world-info');");
const multi=extract(server,'multiQueryCollection');
const source=`// @ts-nocheck -- readable fixed-upstream JavaScript, host adapters below.
/*! SillyTavern 1.19.0, ${commit}, AGPL-3.0-only.
 * See world-info-vector-upstream.json and THIRD_PARTY_NOTICES.md. */
export function createWorldInfoVectorRuntime(deps: any): any {
  const settings=deps.settings, console=deps.console??{debug(){},log(){}};
  const getSortedEntries=deps.getSortedEntries,getSavedHashes=deps.getSavedHashes;
  const insertVectorItems=deps.insertVectorItems,deleteVectorItems=deps.deleteVectorItems;
  const queryMultipleCollections=deps.queryMultipleCollections,getStringHash=deps.getStringHash;
  const substituteParams=deps.substituteParams,collapseNewlines=deps.collapseNewlines;
  const onlyUnique=(value,index,array)=>array.indexOf(value)===index;
  const event_types={WORLDINFO_FORCE_ACTIVATE:'worldinfo_force_activate'};
  const eventSource={emit:(_type,entries)=>deps.forceActivate(entries)};
  const summarize=deps.summarize;
  ${query}
  ${activate}
  return {getQueryText,activateWorldInfo};
}
export function createVectorMultiQuery(deps: any): any {
  const getVector=(_source,_settings,text,_isQuery,_directories)=>deps.getVector(text);
  const getIndex=(_directories,id,_source,_settings)=>deps.getIndex(id);
  ${multi}
  return (collectionIds,searchText,topK,threshold)=>multiQueryCollection(null,collectionIds,null,null,searchText,topK,threshold);
}
`;
const sha=value=>createHash('sha256').update(value).digest('hex');
writeFileSync(resolve('apps/local-service/src/world-info-vector-upstream.ts'),source);
writeFileSync(resolve('apps/local-service/world-info-vector-upstream.json'),JSON.stringify({repository:'https://github.com/SillyTavern/SillyTavern',commit,license:'AGPL-3.0-only',files:[
  {path:'src/world-info-vector-upstream.ts',adaptedSha256:sha(source),upstreamPath:clientPath,upstreamSha256:sha(client),components:['getQueryText','activateWorldInfo'],
    adaptation:'Invocation-local adapters bind current selected raw entries, same-profile embedding collections, real macro substitution and FORCE_ACTIVATE. An already prepared queryText prevents repeating macro side effects during later native scan replay. Retain content-hash synchronization and all-selected-entry activation semantics.'},
  {upstreamPath:serverPath,upstreamSha256:sha(server),components:['multiQueryCollection'],
    adaptation:'Bind getVector/getIndex to the shared validated embedding client and SQLite VectorStore. Keep descending score, threshold then total top-K across all collections; do not copy single-query hashes ignoring the threshold.'},
]},null,2)+'\n');
console.log(JSON.stringify({bytes:Buffer.byteLength(source),sha256:sha(source)}));

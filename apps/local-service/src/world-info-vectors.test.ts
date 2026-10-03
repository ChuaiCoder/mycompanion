import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { parse } from "acorn";
import { DatabaseSync } from "node:sqlite";
import { VectorStore } from "./vector-store.js";
import { VectorCollectionRepository, VectorCollectionSession, VectorCollectionChangedError } from "./vector-collections.js";
import { createVectorMultiQuery } from "./world-info-vector-upstream.js";
import { embeddingSignature, vectorContentFingerprint, type embedTexts } from "./embedding-client.js";
import { activateWorldInfoVectors, worldInfoVectorQueryText, worldInfoVectorSettings } from "./world-info-vectors.js";
import { normalizeWorldInfoEntries, matchLorebookEntries } from "./worldbook-engine.js";
import { createWorldInfoRuntime } from "./world-info-upstream-runtime.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { buildApp } from "./app.js";
import { createTestCharacter } from "./native-fixtures.js";
import { apps, sseResponse, completionResponse } from "./test-helpers.js";
import type { CharacterLorebookEntry, ChatMessage } from "@mycompanion/shared";

const dbs:DatabaseSync[]=[],closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();for(const db of dbs.splice(0))db.close();});
const hash=createWorldInfoRuntime({settings:{},metadata:{}}).getStringHash as (text:string)=>number;
const characterId="00000000-0000-4000-8000-000000000001";
const entry=(index:number,world:string,content:string,extra:Record<string,unknown>={}):CharacterLorebookEntry=>({index,name:String(index),content,keys:["unmatched-key"],secondaryKeys:[],
  enabled:true,constant:false,caseSensitive:false,selective:false,insertionOrder:100-index,sourceEnabled:true,worldInfo:{world,uid:index,vectorized:true,useProbability:false,...extra}});
async function fixture() {
  const requests:Array<{url:string;body:{model:string;input:string[]}}>=[],vectors:Record<string,number[]>={near:[1,0],nearB:[.9,.2],far:[.1,1],opposite:[-1,0],query:[1,0],changed:[0,1]};
  const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString());requests.push({url:req.url!,body});
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({data:body.input.map((text:string,index:number)=>({index,embedding:vectors[text]??[1,0]}))}));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  closes.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const selection={profileId:"embed",settings:{kind:"openai-compatible",baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,model:"embed-fixed"}};
  const db=new DatabaseSync(":memory:");dbs.push(db);const store=new VectorStore(db),collections=new VectorCollectionRepository(db,store),signal=new AbortController().signal;
  return {selection,db,store,collections,signal,requests,vectors,session:new VectorCollectionSession(collections,selection,signal)};
}

it("uses actual embedding HTTP and applies one global top-K/threshold over multiple collections",async()=>{
  const f=await fixture();await f.session.insert("a",[{hash:1,text:"near",index:1},{hash:2,text:"far",index:2}]);
  await f.session.insert("b",[{hash:3,text:"nearB",index:3},{hash:4,text:"opposite",index:4}]);
  const query=createVectorMultiQuery(f.session);
  expect(await query(["a","b"],"query",2,.5)).toEqual({a:{hashes:[1],metadata:[{hash:1,text:"near",index:1}]},b:{hashes:[3],metadata:[{hash:3,text:"nearB",index:3}]}});
  expect(await query(["a","b"],"query",1,.5)).toEqual({a:{hashes:[1],metadata:[{hash:1,text:"near",index:1}]}});
  expect(await query(["b"],"query",10,.99)).toEqual({});
  expect(f.requests.every(item=>item.url==="/v1/embeddings"&&item.body.model==="embed-fixed")).toBe(true);
});

it("synchronizes content edits/deletions, selects semantic matches with no keyword hit, and isolates model/profile caches",async()=>{
  const f=await fixture(),settings=worldInfoVectorSettings({vectors:{enabled_world_info:true,max_entries:1,score_threshold:.8}});
  const initial=normalizeWorldInfoEntries([entry(0,"a","near"),entry(1,"b","far")],characterId);
  const activated=await activateWorldInfoVectors(f.collections,settings,initial,"query",f.selection,f.signal);
  expect(activated.entries.map(item=>[item.world,item.uid])).toEqual([["a",0]]);expect(activated.diagnostics).toEqual([]);
  const report=matchLorebookEntries(characterId,[entry(0,"a","near"),entry(1,"b","far")],"Actor","query",1000,{forcedEntries:activated.entries});
  expect(report.results.map(item=>item.status)).toEqual(["injected","no_match"]);expect(report.results[0]!.matchedKey).toBeNull();
  const collection="world_"+hash("a");expect(f.session.list(collection)).toEqual([hash("near")]);
  const edited=normalizeWorldInfoEntries([entry(0,"a","changed")],characterId);
  await activateWorldInfoVectors(f.collections,settings,edited,"query",f.selection,f.signal);
  expect(f.session.list(collection)).toEqual([hash("changed")]);expect(f.session.list(collection)).not.toContain(hash("near"));
  const other=new VectorCollectionSession(f.collections,{...f.selection,profileId:"other"},f.signal);expect(other.list(collection)).toEqual([]);
  const otherModel=new VectorCollectionSession(f.collections,{...f.selection,settings:{...f.selection.settings,model:"different"}},f.signal);expect(otherModel.list(collection)).toEqual([]);
});

it("retains fixed filtering and same-content activation semantics without authorizing an unselected world",async()=>{
  const f=await fixture(),settings=worldInfoVectorSettings({vectors:{enabled_world_info:true}});
  const sources=[entry(0,"chosen","near"),entry(1,"chosen","near",{vectorized:false}),entry(2,"chosen","far",{vectorized:false}),
    {...entry(3,"chosen","near"),enabled:false},entry(4,"chosen","",{vectorized:true})];
  const result=await activateWorldInfoVectors(f.collections,settings,normalizeWorldInfoEntries(sources,characterId),"query",f.selection,f.signal);
  // Pinned activateWorldInfo maps selected hashes back over all current source
  // entries. Scanner filters still prevent the disabled same-content entry.
  expect(result.entries.map(item=>item.uid)).toEqual([0,1,3]);
  expect(matchLorebookEntries(characterId,sources,"Actor","query",1000,{forcedEntries:result.entries}).results.map(item=>item.status))
    .toEqual(["injected","injected","no_match","disabled","no_match"]);
  expect(f.collections.items("world_"+hash("unselected"),f.session.signature)).toEqual([]);
  expect(f.requests.flatMap(item=>item.body.input)).not.toContain("far");
});

it("keeps extension collections separate from private memory vectors, including purge-all",async()=>{
  const f=await fixture(),fingerprint=vectorContentFingerprint("private memory");
  f.store.put("memory",f.session.signature,"private-id",fingerprint,[1,0]);
  await f.session.insert("memory",[{hash:1,text:"near",index:1}]);
  expect(f.session.list("memory")).toEqual([1]);expect(f.collections.items("memory",f.session.signature).map(item=>item.text)).toEqual(["near"]);
  f.collections.purge();expect(f.session.list("memory")).toEqual([]);
  expect(f.store.get("memory",f.session.signature,"private-id",fingerprint)).toEqual([1,0]);
});

it("does not recreate a purged cold collection when an embedding request completes late",async()=>{
  const f=await fixture();let finish!:(vectors:number[][])=>void;
  const embed=vi.fn<typeof embedTexts>(()=>new Promise(resolve=>{finish=resolve;}));
  const session=new VectorCollectionSession(f.collections,f.selection,f.signal,embed);
  const running=session.insert("cold",[{hash:1,text:"near",index:1}]),rejected=expect(running).rejects.toBeInstanceOf(VectorCollectionChangedError);
  f.collections.purge("cold");finish([[1,0]]);await rejected;expect(session.list("cold")).toEqual([]);
});

it("keeps no-profile and failed-vector diagnostics explicit and never substitutes keyword scoring for vectors",async()=>{
  const f=await fixture(),settings=worldInfoVectorSettings({vectors:{enabled_world_info:true}}),raw=normalizeWorldInfoEntries([entry(0,"a","near")],characterId);
  const missing=await activateWorldInfoVectors(f.collections,settings,raw,"query",null,f.signal);
  expect(missing.entries).toEqual([]);expect(missing.diagnostics[0]).toContain("Embedding 任务");expect(f.requests).toEqual([]);
  const unavailable=await activateWorldInfoVectors(f.collections,settings,raw,"query",f.selection,f.signal,true);
  expect(unavailable.entries).toEqual([]);expect(unavailable.diagnostics[0]).toContain("密钥不可用");
  expect((await activateWorldInfoVectors(f.collections,settings,raw,"query",{...f.selection,settings:{...f.selection.settings,kind:"anthropic"}},f.signal)).diagnostics[0]).toContain("不支持 Embedding");
});

it("prepares the pinned newest-message query with attachment removal, doubled real macro passes and collapsed newlines",async()=>{
  const session=new MacroEvaluationSession(),settings=worldInfoVectorSettings({vectors:{enabled_world_info:true,query:1}});
  const messages=[{content:"older",extensionData:{}},{content:"FILE\n{{incvar::count}}\n\nquery",extensionData:{fileLength:5}}] as ChatMessage[];
  expect(await worldInfoVectorQueryText(messages,settings,session,{characterName:"Actor"})).toBe("1\nquery");expect(session.local.count).toBe(2);
});

it.each(["normal","preview","public-wi"])("uses actual embedding-derived WI activation only at the pinned %s boundary",async mode=>{
  const f=await fixture(),nativeFetch=globalThis.fetch,app=buildApp();apps.push(app);const providerRequests:Record<string,any>[]=[];
  vi.stubGlobal("fetch",async(url:string|URL|Request,init?:RequestInit)=>{
    if(!String(url).startsWith("http://provider.test/"))return nativeFetch(url,init);
    const body=JSON.parse(String(init?.body));if(body.stream)providerRequests.push(body);return body.stream?sseResponse(["reply"]):completionResponse();
  });
  const character=await createTestCharacter(app,{ch_name:"Vector role",first_mes:"Opening"});
  const story=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"ollama",baseUrl:"http://provider.test/v1",model:"gpt-4o",contextLimitTokens:4096,maxTokens:128}});
  const profile=(await app.inject({method:"POST",url:"/api/settings/providers",payload:{name:"embedding",settings:{...f.selection.settings,maxTokens:128,contextLimitTokens:4096}}})).json();
  await app.inject({method:"PATCH",url:"/api/settings/provider-tasks",payload:{embedding:profile.id}});
  await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{vectors:{enabled_world_info:true,query:1,max_entries:1,score_threshold:.8}}}});
  await app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"VectorWorld",data:{entries:{1:{uid:1,key:["NEVER_LITERAL"],vectorized:true,content:"SEMANTIC_WI",position:1}}}}});
  const wi=(await app.inject({method:"GET",url:"/api/worldinfo/settings"})).json();
  await app.inject({method:"PUT",url:"/api/worldinfo/settings",payload:{...wi,world_info:{globalSelect:["VectorWorld"],charLore:[]}}});
  const path=mode==="public-wi"?"/api/worldinfo/prompt":`/api/conversations/${story.id}/${mode==="preview"?"prompt-preview":"messages"}`;
  const payload=mode==="public-wi"?{chat:["query"],maxContext:4096,conversationId:story.id,characterId:character.id,isDryRun:false}
    :mode==="preview"?{draft:"query"}:{content:"query"};
  const response=await app.inject({method:"POST",url:path,payload});expect(response.statusCode,response.body).toBe(200);
  if(mode==="normal"){
    expect(providerRequests).toHaveLength(1);expect(JSON.stringify(providerRequests[0]!.messages)).toContain("SEMANTIC_WI");
    expect(f.requests).toHaveLength(2);expect(f.requests[0]!.body.input).toEqual(["SEMANTIC_WI"]);expect(f.requests[1]!.body.input).toEqual(["query"]);
  }else{expect(f.requests).toEqual([]);expect(response.body).not.toContain('"content":"SEMANTIC_WI"');}
});

it.skipIf(!process.env.SILLYTAVERN_WORLD_INFO_ORACLE_ROOT)("matches pristine fixed-source vector orchestration, global top-K and real query macro occurrence counts",async()=>{
  const root=resolve(process.env.SILLYTAVERN_WORLD_INFO_ORACLE_ROOT!),client=readFileSync(join(root,"public/scripts/extensions/vectors/index.js"),"utf8"),
    server=readFileSync(join(root,"src/endpoints/vectors.js"),"utf8"),sha=(text:string)=>createHash("sha256").update(text).digest("hex");
  expect(sha(client)).toBe("f107cef68090ac3981a5330cd10db8bb20ca4b9118e5ed5acb2b519e244dba4d");
  expect(sha(server)).toBe("0884e92c4402488bd5cd088e6e5f73f88551b95b9873e173fec660e6debee388");
  const declaration=(body:string,name:string)=>{
    const node:any=parse(body,{ecmaVersion:"latest",sourceType:"module"}).body.map((item:any)=>item.type==="ExportNamedDeclaration"?item.declaration:item)
      .find((item:any)=>item?.id?.name===name);
    if(!node)throw new Error("Missing pristine vector declaration "+name);return body.slice(node.start,node.end);
  };
  const original=await fixture(),product=await fixture(),settings=worldInfoVectorSettings({vectors:{enabled_world_info:true,query:1,max_entries:2,score_threshold:.5}});
  let selected:any[]=[],activated:any[]=[];
  const console={debug(){},log(){}},vm=createContext({settings,console,getStringHash:hash,collapseNewlines:(text:string)=>text.replace(/\n+/g,"\n"),
    substituteParams:(text:string)=>text,getSortedEntries:async()=>selected,getSavedHashes:async(id:string)=>original.session.list(id),
    insertVectorItems:(id:string,items:any[])=>original.session.insert(id,items),deleteVectorItems:async(id:string,hashes:number[])=>original.session.remove(id,hashes),
    onlyUnique:(value:unknown,index:number,array:unknown[])=>array.indexOf(value)===index,event_types:{WORLDINFO_FORCE_ACTIVATE:"force"},
    eventSource:{emit:async(type:string,entries:any[])=>{expect(type).toBe("force");activated=entries;}},
    getVector:(_source:unknown,_settings:unknown,text:string)=>original.session.getVector(text),
    getIndex:(_directories:unknown,id:string)=>original.session.getIndex(id),
  });
  // Reference declarations are taken unmodified from the pinned checkout. The
  // product extractor/adapter is never used to build this reference runtime.
  runInContext([declaration(client,"getQueryText"),declaration(client,"activateWorldInfo"),declaration(server,"multiQueryCollection")].join("\n"),vm);
  vm.queryMultipleCollections=(ids:string[],text:string,topK:number,threshold:number)=>runInContext("multiQueryCollection",vm)(null,ids,null,null,text,topK,threshold);
  const phases:any[]=[],worlds=["a","b"];
  for(const phase of [
    {name:"global-top-k",entries:[entry(0,"a","near"),entry(1,"a","far"),entry(2,"b","nearB"),entry(3,"b","opposite")]},
    {name:"edit-delete-duplicate",entries:[entry(0,"a","changed"),entry(4,"a","nearB"),entry(5,"b","nearB",{vectorized:false}),{...entry(6,"b","nearB"),enabled:false}]},
    {name:"threshold",entries:[entry(0,"a","changed"),entry(2,"b","nearB")],threshold:.99},
  ]){
    if(phase.threshold!==undefined)settings.score_threshold=phase.threshold;
    selected=normalizeWorldInfoEntries(phase.entries,characterId);activated=[];
    await runInContext("activateWorldInfo",vm)([{mes:"query",extra:{}}]);
    const native=await activateWorldInfoVectors(product.collections,settings,selected,"query",product.selection,product.signal);
    expect(native.diagnostics).toEqual([]);
    const ids=(entries:any[])=>entries.map(raw=>[raw.world,raw.uid]);expect(ids(native.entries),phase.name).toEqual(ids(activated));
    const collections=Object.fromEntries(worlds.map(world=>[world,original.session.list("world_"+hash(world))]));
    expect(Object.fromEntries(worlds.map(world=>[world,product.session.list("world_"+hash(world))]))).toEqual(collections);
    phases.push({name:phase.name,original:ids(activated),product:ids(native.entries),collections});
  }
  expect(product.requests.map(item=>item.body.input)).toEqual(original.requests.map(item=>item.body.input));
  let count=0;vm.substituteParams=(text:string)=>text.replace("{{incvar::count}}",()=>String(++count));
  const messages=[{content:"older",extensionData:{}},{content:"FILE\n{{incvar::count}}\n\nquery",extensionData:{fileLength:5}}] as ChatMessage[];
  const originalQuery=await runInContext("getQueryText",vm)(messages.map(message=>({mes:message.content,extra:message.extensionData})),"world-info");
  const macro=new MacroEvaluationSession(),productQuery=await worldInfoVectorQueryText(messages,settings,macro,{characterName:"Actor"});
  expect(productQuery).toBe(originalQuery);expect(macro.local.count).toBe(count);
  const report=process.env.MYCOMPANION_WORLD_INFO_VECTOR_ORACLE_REPORT;
  if(report)writeFileSync(resolve(report),JSON.stringify({passed:true,commit:"7e8663cd9c184a550b37238218bdd32c6efc68e9",clientSha256:sha(client),serverSha256:sha(server),
    phases,originalEmbeddingInputs:original.requests.map(item=>item.body.input),productEmbeddingInputs:product.requests.map(item=>item.body.input),
    originalQuery,productQuery,originalMacroCount:count,productMacroCount:macro.local.count},null,2));
});

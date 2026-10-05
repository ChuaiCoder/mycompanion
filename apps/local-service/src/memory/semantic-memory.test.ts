import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
import type { MemoryRecord } from "@mycompanion/shared";
import { SemanticMemoryRetriever, type EmbeddingSelection } from "./semantic-memory.js";
import { VectorStore } from "./vector-store.js";
import { embedTexts, embeddingSignature, vectorContentFingerprint } from "./embedding-client.js";

function memory(content:string,patch:Partial<MemoryRecord>={}):MemoryRecord {
  return {id:randomUUID(),conversationId:randomUUID(),characterId:randomUUID(),type:"fact",content,scope:"story",importance:3,status:"active",pinned:false,
    sourceMessageIds:[],supersededBy:null,previousContent:null,createdAt:"2026-10-02T00:00:00.000Z",lastUsedAt:null,...patch};
}
describe("semantic memory recall with source-safe cache",()=>{
  it("persists exact vectors across restart but refuses changed content, other namespaces/models and corrupt dimensions",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"mycompanion-vectors-"));
    let db=new DatabaseSync(join(dir,"vectors.sqlite"));
    try {
      let store=new VectorStore(db);
      store.put("memory","s","id","v1",[1,0]);store.put("world:a","s","id","v1",[0,1]);
      db.close();db=new DatabaseSync(join(dir,"vectors.sqlite"));store=new VectorStore(db);
      expect(store.query("memory","s",[1,0],[{id:"id",fingerprint:"v1"}],10,0.4)).toEqual([{id:"id",score:1}]);
      expect(store.get("memory","s","id","v2")).toBeUndefined();expect(store.get("memory","other","id","v1")).toBeUndefined();
      expect(store.query("world:a","s",[1,0],[{id:"id",fingerprint:"v1"}],10,0.4)).toEqual([]);
      db.prepare("UPDATE embedding_vectors SET dimensions=999999999 WHERE namespace='memory'").run();
      expect(store.get("memory","s","id","v1")).toBeUndefined();
    } finally {db.close();await rm(dir,{recursive:true,force:true});}
  });
  it("indexes with real HTTP without delaying the cold chat, recalls a paraphrase and protects pinned/hidden sources",async()=>{
    const requests:Array<{input:string[];model:string}>=[];
    const vectors:Record<string,number[]>={"阿岚把黄铜钥匙交给林医生保管。": [1,0,0],"今天下雨。": [0,1,0],"开门的东西在谁那儿？": [0.99,0,0.01]};
    const remote=createServer(async(req,res)=>{
      const parts:Buffer[]=[];for await(const chunk of req)parts.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(parts).toString());requests.push(body);
      res.end(JSON.stringify({data:body.input.map((text:string,index:number)=>({index,embedding:vectors[text]}))}));
    });
    remote.listen(0,"127.0.0.1");await once(remote,"listening");
    const selection:EmbeddingSelection={profileId:"embed",settings:{kind:"custom",model:"controlled-fixture",baseUrl:`http://127.0.0.1:${(remote.address() as {port:number}).port}/v1`}};
    const db=new DatabaseSync(":memory:"),store=new VectorStore(db);
    const relevant=memory("阿岚把黄铜钥匙交给林医生保管。"),irrelevant=memory("今天下雨。"),pinned=memory("你总是带着围巾。",{pinned:true});
    const disabled=memory("已经撤销的秘密。",{status:"orphaned"});
    const byId=new Map([relevant,irrelevant,pinned,disabled].map(item=>[item.id,item]));
    const retriever=new SemanticMemoryRetriever(store,()=>selection,id=>byId.get(id));
    const input={conversationId:relevant.conversationId,memories:[relevant,irrelevant,pinned,disabled],scanText:"开门的东西在谁那儿？",model:"gpt-4o"};
    try {
      const cold=await retriever.retrieve(input);expect(cold.retrieval).toMatchObject({mode:"keyword",pendingCount:2});expect(cold.results.filter(item=>item.injected).map(item=>item.memoryId)).toEqual([pinned.id]);
      await retriever.idle();
      const hot=await retriever.retrieve(input);expect(hot.retrieval).toMatchObject({mode:"hybrid",indexedCount:2,pendingCount:0});
      expect(hot.results.find(item=>item.memoryId===relevant.id)).toMatchObject({injected:true,keywordScore:0,semanticScore:expect.any(Number)});
      expect(hot.results.find(item=>item.memoryId===irrelevant.id)?.injected).toBe(false);
      expect(hot.results.find(item=>item.memoryId===disabled.id)?.injected).toBe(false);
      expect(hot.results.find(item=>item.memoryId===pinned.id)?.injected).toBe(true);
      expect(requests.flatMap(item=>item.input)).not.toContain(disabled.content);expect(requests.flatMap(item=>item.input)).not.toContain(pinned.content);
      expect(requests).toHaveLength(2);expect(requests.every(item=>item.model==="controlled-fixture")).toBe(true);
    } finally {await retriever.close();db.close();remote.closeAllConnections();await new Promise<void>(resolve=>remote.close(()=>resolve()));}
  });
  it("does not write a dry-run index or late edited/deleted/configuration-changed source",async()=>{
    const db=new DatabaseSync(":memory:"),store=new VectorStore(db),fact=memory("first");
    let selection:EmbeddingSelection|undefined={profileId:"a",settings:{kind:"custom",baseUrl:"http://localhost:11/v1",model:"m"}};
    let current:MemoryRecord|undefined=fact;
    const releases:Array<()=>void>=[];
    const controlled=vi.fn<typeof embedTexts>(async()=>{await new Promise<void>(resolve=>releases.push(resolve));return [[1,0]];});
    const retriever=new SemanticMemoryRetriever(store,()=>selection,()=>current,controlled);
    const input={conversationId:fact.conversationId,memories:[fact],scanText:"q"};
    try {
      await retriever.retrieve({...input,dryRun:true});expect(controlled).not.toHaveBeenCalled();
      await retriever.retrieve(input);await retriever.retrieve(input);expect(controlled).toHaveBeenCalledTimes(1);
      current={...fact,content:"edited"};releases.shift()!();await retriever.idle();
      expect(store.get("memory",embeddingSignature(selection!.settings,"a"),fact.id,vectorContentFingerprint(fact.content))).toBeUndefined();
      await retriever.retrieve(input);current=undefined;releases.shift()!();await retriever.idle();
      expect(db.prepare("SELECT count(*) n FROM embedding_vectors").get()).toMatchObject({n:0});
      current=fact;await retriever.retrieve(input);selection={...selection!,settings:{...selection!.settings,model:"new"}};releases.shift()!();await retriever.idle();
      expect(db.prepare("SELECT count(*) n FROM embedding_vectors").get()).toMatchObject({n:0});
    } finally {releases.forEach(release=>release());await retriever.close();db.close();}
  });
  it("keeps keyword and fixed budgets when an embedding query fails and rejects cancellation",async()=>{
    const db=new DatabaseSync(":memory:"),store=new VectorStore(db),fact=memory("朋友送来一束鲜花。"),pinned=memory("always",{pinned:true});
    const selection={profileId:"a",settings:{kind:"custom",baseUrl:"http://localhost:11/v1",model:"m"}};
    store.put("memory",embeddingSignature(selection.settings,"a"),fact.id,vectorContentFingerprint(fact.content),[1,0]);
    const controlled=vi.fn<typeof embedTexts>(async()=>{throw new Error("secret-body-do-not-return");});
    const retriever=new SemanticMemoryRetriever(store,()=>selection,()=>fact,controlled);
    const input={conversationId:fact.conversationId,memories:[fact,pinned],scanText:"鲜花",dryRun:true};
    try {
      const result=await retriever.retrieve(input);expect(result.retrieval?.mode).toBe("keyword");expect(JSON.stringify(result)).not.toContain("secret-body-do-not-return");
      expect(result.results.every(item=>item.injected)).toBe(true);expect(result.pinnedBudgetTokens).toBe(300);
      const controller=new AbortController();controller.abort();await expect(retriever.retrieve({...input,signal:controller.signal})).rejects.toThrow();
    } finally {await retriever.close();db.close();}
  });
  it("uses the invocation's captured provider even when routing changes, and honors explicit no-embedding",async()=>{
    const db=new DatabaseSync(":memory:"),store=new VectorStore(db),fact=memory("remembered");
    const captured={profileId:"a",settings:{kind:"openai-compatible",baseUrl:"http://localhost:11/v1",model:"old"},apiKey:"old-key"};
    const changed={profileId:"b",settings:{kind:"openai-compatible",baseUrl:"http://localhost:12/v1",model:"new"},apiKey:"new-key"};
    store.put("memory",embeddingSignature(captured.settings,"a"),fact.id,vectorContentFingerprint(fact.content),[1,0]);
    const controlled=vi.fn<typeof embedTexts>(async()=>[[1,0]]);
    const retriever=new SemanticMemoryRetriever(store,()=>changed,()=>fact,controlled);
    const input={conversationId:fact.conversationId,memories:[fact],scanText:"q",dryRun:true};
    try {
      const result=await retriever.retrieve({...input,embeddingSelection:captured});
      expect(result.retrieval).toMatchObject({mode:"hybrid",embeddingModel:"old"});
      expect(controlled).toHaveBeenCalledWith(captured.settings,["q"],expect.objectContaining({apiKey:"old-key"}));
      await retriever.retrieve({...input,embeddingSelection:null});expect(controlled).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("old-key");
    } finally {await retriever.close();db.close();}
  });
  it("distinguishes an unavailable assigned credential from no embedding assignment without retrying or leaking it",async()=>{
    const db=new DatabaseSync(":memory:"),store=new VectorStore(db),fact=memory("朋友送来鲜花。");
    const resolve=vi.fn(()=>{throw new Error("encrypted-secret");});
    const controlled=vi.fn<typeof embedTexts>(async()=>[[1,0]]);
    const retriever=new SemanticMemoryRetriever(store,resolve,()=>fact,controlled);
    const input={conversationId:fact.conversationId,memories:[fact],scanText:"鲜花",embeddingSelection:null};
    try {
      const unavailable=await retriever.retrieve({...input,embeddingSelectionUnavailable:true});
      expect(unavailable.retrieval).toMatchObject({mode:"keyword",diagnostics:["Embedding 配置或凭据不可用，已使用关键词检索。"]});
      expect(unavailable.results[0]).toMatchObject({memoryId:fact.id,injected:true});
      const disabled=await retriever.retrieve(input);
      expect(disabled.retrieval?.diagnostics).toEqual(["未指定 Embedding 模型，已使用关键词检索。"]);
      expect(resolve).not.toHaveBeenCalled();expect(controlled).not.toHaveBeenCalled();
      expect(JSON.stringify(unavailable)).not.toContain("encrypted-secret");
      expect(db.prepare("SELECT count(*) n FROM embedding_vectors").get()).toMatchObject({n:0});
    } finally {await retriever.close();db.close();}
  });
});

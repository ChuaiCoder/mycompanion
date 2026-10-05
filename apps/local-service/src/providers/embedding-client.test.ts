import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { cosineSimilarity, embedTexts, embeddingEndpoint, embeddingSignature, EmbeddingRequestError } from "./embedding-client.js";

async function provider(handle:(body:Record<string,unknown>,request:IncomingMessage,response:ServerResponse)=>void) {
  const requests: Array<{url:string;auth?:string|undefined;body:Record<string,unknown>}> = [];
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[]; for await(const chunk of request) chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push({url:request.url!,auth:request.headers.authorization,body});
    handle(body,request,response);
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const address=server.address() as {port:number};
  return {url:`http://127.0.0.1:${address.port}`,requests,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));}};
}

describe("validated embedding transport",()=>{
  it("uses real OpenAI batch HTTP, restores index order and scopes cache to the complete provider target",async()=>{
    const remote=await provider((_body,_request,response)=>response.end(JSON.stringify({data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}]})));
    try {
      const settings={kind:"openai-compatible",baseUrl:remote.url+"/proxy/v1",model:"embed-fixed"};
      expect(await embedTexts(settings,["a","b"],{apiKey:"sentinel-local"})).toEqual([[1,0],[0,1]]);
      expect(remote.requests).toEqual([{url:"/proxy/v1/embeddings",auth:"Bearer sentinel-local",body:{model:"embed-fixed",input:["a","b"]}}]);
      expect(embeddingSignature(settings,"a")).not.toEqual(embeddingSignature({...settings,baseUrl:remote.url+"/other/v1"},"a"));
      expect(embeddingSignature(settings,"a")).not.toEqual(embeddingSignature(settings,"b"));
      expect(cosineSimilarity([2,2],[10,10])).toBeCloseTo(1);
      expect(()=>cosineSimilarity([1,0],[1,0,3])).toThrow();
    } finally {await remote.close();}
  });
  it("uses the Ollama protocol at the retained proxy path and does not invent an API key",async()=>{
    const remote=await provider((_body,_request,response)=>response.end(JSON.stringify({embeddings:[[0,1],[1,0]]})));
    try {
      expect(await embedTexts({kind:"ollama",baseUrl:remote.url+"/proxy/v1",model:"nomic-fixed"},["a","b"])).toEqual([[0,1],[1,0]]);
      expect(remote.requests).toEqual([{url:"/proxy/api/embed",auth:undefined,body:{model:"nomic-fixed",input:["a","b"],truncate:false}}]);
    } finally {await remote.close();}
  });
  it.each([
    {data:[{index:0,embedding:[1,0]},{index:0,embedding:[0,1]}]},
    {data:[{index:1,embedding:[1,0]}]},
    {data:[{index:0,embedding:[1]},{index:1,embedding:[0,1]}]},
    {data:[{index:0,embedding:[0,0]},{index:1,embedding:[0,1]}]},
    {data:[{index:0,embedding:["Infinity"]},{index:1,embedding:[0,1]}]},
  ])("rejects incomplete, duplicate, zero or malformed vectors without a partial result %#",async data=>{
    const remote=await provider((_body,_request,response)=>response.end(JSON.stringify(data)));
    try {await expect(embedTexts({kind:"openai",baseUrl:remote.url,model:"m"},["a","b"])).rejects.toMatchObject({code:"INVALID_RESPONSE"});}
    finally {await remote.close();}
  });
  it("never exposes provider errors or follows a credential-bearing redirect",async()=>{
    const sink=await provider((_body,_request,response)=>response.end("{}"));
    const remote=await provider((_body,_request,response)=>{
      response.statusCode=302;response.statusMessage="secret-sentinel";response.setHeader("Location",sink.url+"/capture");response.end("secret-sentinel");
    });
    try {
      const error=await embedTexts({kind:"custom",baseUrl:remote.url,model:"m"},["a"],{apiKey:"secret-sentinel"}).catch(error=>error);
      expect(error).toBeInstanceOf(EmbeddingRequestError);expect(String(error)).not.toContain("secret-sentinel");expect(sink.requests).toEqual([]);
    } finally {await remote.close();await sink.close();}
  });
  it("bounds response streaming and rejects a cancelled response even when a transport ignores abort",async()=>{
    const fake=vi.fn<typeof fetch>(async()=>new Response(new Uint8Array(16*1024*1024+1)));
    await expect(embedTexts({kind:"custom",baseUrl:"http://localhost:11/v1",model:"m"},["a"],{fetch:fake})).rejects.toMatchObject({code:"INVALID_RESPONSE"});
    const controller=new AbortController();
    const late=vi.fn<typeof fetch>(async()=>{controller.abort();return Response.json({data:[{index:0,embedding:[1]}]});});
    await expect(embedTexts({kind:"custom",baseUrl:"http://localhost:11/v1",model:"m"},["a"],{fetch:late,signal:controller.signal})).rejects.toThrow();
    expect(()=>embeddingEndpoint({kind:"custom",baseUrl:"http://user:password@localhost",model:"m"})).toThrow();
    expect(()=>embeddingEndpoint({kind:"custom",baseUrl:"http://localhost?api_key=sentinel",model:"m"})).toThrow();
  });
});

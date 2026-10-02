import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { apps, completionResponse, sseResponse } from "./test-helpers.js";
import { sameProviderCredentialScope } from "./provider-credential-scope.js";

const settings={kind:"openai-compatible" as const,baseUrl:"https://old-provider.example/v1",model:"gpt-4o",maxTokens:128,contextLimitTokens:4096};
const codec={seal:(value:string)=>`encrypted:${value}`,unseal:(value:string)=>value.slice(10)};

it("compares the effective endpoint path and protocol, allowing only transport-equivalent URL normalization",()=>{
  expect(sameProviderCredentialScope(settings,{...settings,baseUrl:"https://OLD-PROVIDER.example:443/v1/"})).toBe(true);
  expect(sameProviderCredentialScope(settings,{...settings,baseUrl:settings.baseUrl+"//"})).toBe(false);
  expect(sameProviderCredentialScope(settings,{...settings,baseUrl:"https://old-provider.example/v2"})).toBe(false);
  expect(sameProviderCredentialScope(settings,{...settings,kind:"ollama"})).toBe(false);
  expect(sameProviderCredentialScope(settings,{...settings,baseUrl:"https://new-provider.example/v1"})).toBe(false);
});

it.each(["settings-put","extension-patch","same-origin-path","protocol-kind"])("clears a saved credential when %s changes its target and sends no key in a real native request",async mode=>{
  const app=buildApp({secretCodec:codec});apps.push(app);
  const first=await app.inject({method:"PUT",url:"/api/settings/provider",payload:{...settings,apiKey:"old-scope-secret"}});
  expect(first.json().hasApiKey).toBe(true);
  const next=mode==="same-origin-path"?{...settings,baseUrl:"https://old-provider.example/v2"}
    :mode==="protocol-kind"?{...settings,kind:"ollama"}:{...settings,baseUrl:"https://new-provider.example/v1"};
  const saved=mode==="extension-patch"
    ?await app.inject({method:"PATCH",url:"/api/settings/provider/extension-patch",payload:{values:{baseUrl:next.baseUrl},baseline:first.json()}})
    :await app.inject({method:"PUT",url:"/api/settings/provider",payload:next});
  expect(saved.statusCode,saved.body).toBe(200);
  expect(mode==="extension-patch"?saved.json().provider.hasApiKey:saved.json().hasApiKey).toBe(false);
  const requests:Array<{url:string;authorization:string|null}>=[];
  vi.stubGlobal("fetch",async(url:URL|string|Request,init?:RequestInit)=>{
    requests.push({url:String(url),authorization:new Headers(init?.headers).get("Authorization")});
    return JSON.parse(String(init?.body)).stream?sseResponse(["actual reply"]):completionResponse('{"memories":[]}');
  });
  const avatar=(await app.inject({method:"POST",url:"/api/characters/create",payload:{ch_name:"Credential scope",first_mes:"Hello"}})).body;
  const character=(await app.inject({method:"POST",url:"/api/characters/get",payload:{avatar_url:avatar}})).json();
  const story=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  const result=await app.inject({method:"POST",url:`/api/conversations/${story.id}/messages`,payload:{content:"Speak"}});
  expect(result.statusCode,result.body).toBe(200);expect(result.body).toContain('"type":"done"');
  expect(requests.length).toBeGreaterThan(0);expect(requests[0]!.url).toBe(next.baseUrl+"/chat/completions");
  expect(requests.every(request=>request.authorization===null)).toBe(true);
  expect(result.body+saved.body).not.toContain("old-scope-secret");
});

it("keeps credentials for the same target and accepts an explicit new target key",async()=>{
  const app=buildApp({secretCodec:codec});apps.push(app);
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:{...settings,apiKey:"old-scope-secret"}});
  const unchanged=await app.inject({method:"PUT",url:"/api/settings/provider",payload:{...settings,baseUrl:settings.baseUrl+"/",model:"changed-model"}});
  expect(unchanged.json().hasApiKey).toBe(true);
  const replaced=await app.inject({method:"PUT",url:"/api/settings/provider",payload:{...settings,baseUrl:"https://new-provider.example/v1",apiKey:"new-scope-secret"}});
  expect(replaced.json().hasApiKey).toBe(true);
  const fetchMock=vi.fn(async()=>completionResponse("OK"));vi.stubGlobal("fetch",fetchMock);
  expect((await app.inject({method:"POST",url:"/api/settings/provider/test",payload:{...settings,baseUrl:"https://new-provider.example/v1"}})).json().ok).toBe(true);
  const init=(fetchMock.mock.calls[0] as unknown as [URL,RequestInit])[1];
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer new-scope-secret");
});

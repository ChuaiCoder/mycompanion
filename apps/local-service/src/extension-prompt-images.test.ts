import { expect,it } from "vitest";
import {buildApp} from "./app.js";
import {apps} from "./test-helpers.js";
import {imageTokenCost} from "./image-token-cost.js";
import {countCompatibilityMessagesSync} from "./tokenizer-service.js";

const image="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9rS3lGQAAAABJRU5ErkJggg==";
async function setup(experimental=false){
  const app=buildApp();apps.push(app);
  const created=await app.inject({method:"POST",url:"/api/characters/create",payload:{ch_name:"Picture role",first_mes:"Opening",description:"Character"}});
  expect(created.statusCode,created.body).toBe(200);
  const character=(await app.inject({method:"POST",url:"/api/characters/get",payload:{avatar_url:created.body}})).json();
  const conversation=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  expect((await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"openai-compatible",baseUrl:"http://provider.test/v1",model:"gpt-4o",maxTokens:128,contextLimitTokens:8192}})).statusCode).toBe(200);
  expect((await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{__mycompanion_power_user:{experimental_macro_engine:experimental}}}})).statusCode).toBe(200);
  const send=(messages:unknown[],extra:Record<string,unknown>={})=>app.inject({method:"POST",url:`/api/conversations/${conversation.id}/extension-prompt-assembly`,payload:{messages,messageExamples:[],extensionPrompts:[],...extra}});
  return {app,conversation,send};
}

it.each([false,true])("keeps single-image bytes attached to the admitted source message after the same string macro phases (experimental=%s)",async experimental=>{
  const f=await setup(experimental);
  const input={role:"user",content:"{{char}}/{{incvar::imageUser}}"};
  const plain=await f.send([input]);expect(plain.statusCode,plain.body).toBe(200);
  const pictured=await f.send([{...input,image}],{imageQuality:"high"});expect(pictured.statusCode,pictured.body).toBe(200);
  const result=pictured.json(),baseline=plain.json();
  const message=result.messages.find((message:{role:string})=>message.role==="user");
  expect(message.content).toEqual([{type:"text",text:baseline.messages.find((message:{role:string})=>message.role==="user").content},
    {type:"image_url",image_url:{url:image,detail:"high"}}]);
  const cost=imageTokenCost(message.content[1],"gpt-4o").tokens;
  expect(result.totalTokens).toBe(baseline.totalTokens+cost);
  expect(result.totalTokens).toBe(countCompatibilityMessagesSync(result.messages,"gpt-4o",true)+128+512);
  const exceeded=await f.send([{...input,image}],{imageQuality:"high",contextLimitTokens:baseline.totalTokens+cost-1});
  expect(exceeded.statusCode,exceeded.body).toBe(400);
  expect(exceeded.json().error.code).toBe("PROMPT_CONTEXT_EXCEEDED");
  const after=(await f.app.inject({url:`/api/conversations/${f.conversation.id}`})).json();
  expect(after.messages).toEqual(f.conversation.messages);expect(after.chatMetadata.variables).toBeUndefined();
});

it("retains an image-only current input and preserves pictures on independently budgeted example messages",async()=>{
  const f=await setup();
  const response=await f.send([{role:"user",content:"",image}],{imageQuality:"low",messageExamples:[[{role:"user",name:"ExampleUser",content:"EXAMPLE",image}]]});
  expect(response.statusCode,response.body).toBe(200);
  const result=response.json();
  expect(result.messages.find((message:{role:string})=>message.role==="user").content).toEqual([
    {type:"text",text:""},{type:"image_url",image_url:{url:image,detail:"low"}},
  ]);
  expect(result.messages.some((message:{content:unknown})=>Array.isArray(message.content)&&message.content.some(part=>part.type==="text"&&part.text==="EXAMPLE"))).toBe(true);
  expect(result.totalTokens).toBe(countCompatibilityMessagesSync(result.messages,"gpt-4o",true)+128+512);
});

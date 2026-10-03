import {expect,it,vi} from "vitest";
import {buildApp} from "./app.js";
import {apps} from "./test-helpers.js";
import reference from "./fixtures/prompt-lifecycle-upstream-reference.json" with { type: "json" };

async function fixture(experimental: boolean) {
  const app=buildApp();apps.push(app);
  const avatar=(await app.inject({method:"POST",url:"/api/characters/create",payload:{ch_name:"Macro API",first_mes:"Hello"}})).body;
  const character=(await app.inject({method:"POST",url:"/api/characters/get",payload:{avatar_url:avatar}})).json();
  const story=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"ollama",baseUrl:"http://provider.test/v1",model:"gpt-4o",maxTokens:128,contextLimitTokens:4096}});
  await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{__mycompanion_power_user:{experimental_macro_engine:experimental,persona_description:"PERSONA={{incvar::assembled}}/{{getvar::scanned}}",persona_description_position:0}}}});
  await app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"api-macros",data:{entries:{1:{uid:1,constant:true,key:[],content:"WORLD={{incvar::scanned}}/{{incglobalvar::shared}}",position:1}}}}});
  const worldSettings=(await app.inject({method:"GET",url:"/api/worldinfo/settings"})).json();
  await app.inject({method:"PUT",url:"/api/worldinfo/settings",payload:{...worldSettings,world_info:{globalSelect:["api-macros"],charLore:[]}}});
  const chat=async()=>(await app.inject({method:"GET",url:`/api/conversations/${story.id}`})).json();
  const settings=async()=>(await app.inject({method:"GET",url:"/api/extensions/settings"})).json().extensionSettings;
  const scan=async(extra:Record<string,unknown>={})=>app.inject({method:"POST",url:"/api/worldinfo/prompt",payload:{chat:[],maxContext:4096,characterId:character.id,conversationId:story.id,metadata:(await chat()).chatMetadata,commitVariables:true,...extra}});
  const assemble=(extra:Record<string,unknown>={})=>app.inject({method:"POST",url:`/api/conversations/${story.id}/extension-prompt-assembly`,payload:{messages:[{role:"user",content:"input"}],commitVariables:true,...extra}});
  return {app,character,story,chat,settings,scan,assemble};
}

it.each([false])("publishes public API effects once before extension transport (experimental=%s)",async experimental=>{
  const f=await fixture(experimental);
  const scan=await f.scan();expect(scan.statusCode,scan.body).toBe(200);
  expect(scan.json().report.block).toBe("WORLD=1/1");expect(scan.json().macroChanges).toHaveLength(experimental?2:3);
  // Executed upstream oracle: a public legacy WI call eagerly reads the real
  // card/persona; its later independent persona call reads then substitutes.
  expect((await f.chat()).chatMetadata.variables).toEqual(experimental?{scanned:1}:{scanned:1,assembled:1});
  const assembly=await f.assemble({worldInfoBefore:"",worldInfoAfter:scan.json().report.block});
  const oracle=reference.runs.find(run=>run.mode==="public-single"&&run.experimental===experimental)!;
  expect(assembly.statusCode,assembly.body).toBe(200);expect(assembly.json().messages).toEqual(oracle.messages);
  const before=await f.chat();expect(before.chatMetadata.variables).toEqual(oracle.variables);
  const sent:Record<string,unknown>[]=[];
  vi.stubGlobal("fetch",async(_url:unknown,init:RequestInit)=>{sent.push(JSON.parse(String(init.body)));return Response.json({error:{message:"provider rejected"}},{status:429});});
  const response=await f.app.inject({method:"POST",url:"/api/backends/chat-completions/generate",payload:{messages:assembly.json().messages,max_tokens:128,_mycompanion_context_limit:4096}});
  expect(response.statusCode).toBe(429);expect(sent).toHaveLength(1);
  expect(await f.chat()).toEqual(before);expect((await f.settings()).variables.global.shared).toBe(1);
  const next=await f.scan();expect(next.json().report.block).toBe("WORLD=2/2");
});

it.each([false])("keeps explicit internal read-only scans and previews free of writes (experimental=%s)",async experimental=>{
  const f=await fixture(experimental),before=await f.chat(),settings=await f.settings();
  const scan=await f.scan({commitVariables:false});expect(scan.statusCode).toBe(200);expect(scan.json().report.block).toBe("WORLD=1/1");
  const assembly=await f.assemble({commitVariables:false});expect(assembly.statusCode,assembly.body).toBe(200);
  const oracle=reference.runs.find(run=>run.mode==="public-readonly"&&run.experimental===experimental)!;
  expect(assembly.json().messages).toEqual(oracle.messages);
  const assemblyText=JSON.stringify(assembly.json().messages);
  expect(assemblyText).not.toContain("WORLD=");
  const preview=await f.app.inject({method:"POST",url:`/api/conversations/${f.story.id}/prompt-preview`,payload:{}});
  expect(preview.statusCode).toBe(200);expect(await f.chat()).toEqual(before);expect(await f.settings()).toEqual(settings);
});

it("rejects a stale public scan atomically and preserves the competing writer",async()=>{
  const f=await fixture(true);await f.scan();
  const rejected=await f.scan({metadata:{variables:{scanned:0}},globalVariables:{shared:1}});
  expect(rejected.statusCode,rejected.body).toBe(409);expect(rejected.json().error.code).toBe("MACRO_VARIABLE_CONFLICT");
  expect((await f.chat()).chatMetadata.variables.scanned).toBe(1);expect((await f.settings()).variables.global.shared).toBe(1);
  const recovered=await f.scan();expect(recovered.json().report.block).toBe("WORLD=2/2");
});

it.each([false,true])("uses saved story variables when public scan metadata is omitted (experimental=%s)",async experimental=>{
  const f=await fixture(experimental);
  for(const count of [1,2]){
    const result=await f.scan({metadata:undefined});
    expect(result.statusCode,result.body).toBe(200);
    expect(result.json().report.block).toBe(`WORLD=${count}/${count}`);
  }
  expect((await f.chat()).chatMetadata.variables.scanned).toBe(2);
  expect((await f.settings()).variables.global.shared).toBe(2);
});

it("persists neutral-chat globals without inventing a conversation or saving local state",async()=>{
  const f=await fixture(true),before=await f.chat();
  const result=await f.scan({conversationId:null,characterId:null,metadata:{}});
  expect(result.statusCode,result.body).toBe(200);expect(result.json().report.block).toBe("WORLD=1/1");
  expect(result.json().macroChanges.some((change:{scope:string})=>change.scope==="local")).toBe(true);
  expect(await f.chat()).toEqual(before);expect((await f.settings()).variables.global.shared).toBe(1);
});

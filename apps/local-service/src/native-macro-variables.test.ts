import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { apps, sseResponse } from "./test-helpers.js";
import reference from "./fixtures/prompt-remaining-upstream-reference.json" with { type: "json" };

it.each([false, true])("only evaluates NONE extension prompts when scanning is requested (skipWIAN=%s)", async skipWIAN => {
  const app = buildApp(); apps.push(app);
  const avatar = (await app.inject({ method: "POST", url: "/api/characters/create", payload: { ch_name: "Macro", first_mes: "Hello" } })).body;
  const character = (await app.inject({ method: "POST", url: "/api/characters/get", payload: { avatar_url: avatar } })).json();
  const story = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
  await app.inject({ method: "PUT", url: "/api/settings/provider", payload: { kind: "ollama", baseUrl: "http://provider.test/v1", model: "gpt-4o", contextLimitTokens: 4096, maxTokens: 128 } });
  await app.inject({ method: "PUT", url: "/api/extensions/settings", payload: { extensionSettings: { __mycompanion_power_user: { experimental_macro_engine: true } } } });
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => { sent.push(JSON.parse(String(init.body))); return sseResponse(["reply"]); }));
  const extensionPrompts = [false, true].map(scan => ({ key: scan ? "scan" : "unused", value: `HIDDEN {{incvar::${scan ? "scanned" : "unused"}}}`, position: -1, depth: 0, role: 0, scan }));
  const response = await app.inject({ method: "POST", url: `/api/conversations/${story.id}/quiet-generation`, payload: { extensionPrompts, skipWIAN } });
  expect(response.statusCode, response.body).toBe(200);
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent[0]!.messages)).not.toContain("HIDDEN");
  const saved = (await app.inject({ method: "GET", url: `/api/conversations/${story.id}` })).json();
  expect(saved.chatMetadata.variables ?? {}).toEqual(skipWIAN ? {} : { scanned: 1 });
});

it.each([false])("commits one normal/quiet draft while previews stay read-only (experimental=%s)",async experimental=>{
  const app=buildApp();apps.push(app);
  const avatar=(await app.inject({method:"POST",url:"/api/characters/create",payload:{ch_name:"Macro",first_mes:"Hello",description:"CARD={{incvar::card}}/{{incglobalvar::global}}"}})).body;
  const character=(await app.inject({method:"POST",url:"/api/characters/get",payload:{avatar_url:avatar}})).json();
  const story=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  await app.inject({method:"PUT",url:"/api/settings/provider",payload:{kind:"ollama",baseUrl:"http://provider.test/v1",model:"gpt-4o",contextLimitTokens:4096,maxTokens:128}});
  await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:{__mycompanion_power_user:{experimental_macro_engine:experimental,persona_description:"PERSONA={{incvar::persona}}",persona_description_position:0}}}});
  await app.inject({method:"POST",url:"/api/worldinfo/edit",payload:{name:"macro",data:{entries:{
    1:{uid:1,key:[],constant:true,content:"WORLD={{incvar::world}}",disable:false,position:1},
    2:{uid:2,key:[],constant:true,content:"{{incvar::disabled}}",disable:true,position:1},
    3:{uid:3,key:["absent-key"],content:"{{incvar::unmatched}}",disable:false,position:1},
  }}}});
  const wi=(await app.inject({method:"GET",url:"/api/worldinfo/settings"})).json();
  await app.inject({method:"PUT",url:"/api/worldinfo/settings",payload:{...wi,world_info:{globalSelect:["macro"],charLore:[]}}});
  const extensionPrompts=[{key:"once",value:"EXT={{incvar::extension}}",position:1,depth:0,role:0,scan:true}];
  const chat=async()=>(await app.inject({method:"GET",url:`/api/conversations/${story.id}`})).json();
  const settings=async()=>(await app.inject({method:"GET",url:"/api/extensions/settings"})).json().extensionSettings;
  const before=await chat(),initialSettings=await settings();
  const preview=await app.inject({method:"POST",url:`/api/conversations/${story.id}/prompt-preview`,payload:{extensionPrompts}});
  expect(preview.statusCode,preview.body).toBe(200);
  const previewText=JSON.stringify(preview.json().messages);
  const oracle=(round:number)=>reference.runs.find(run=>run.mode==="native-vars"&&run.experimental===experimental&&run.round===round)!;
  expect(preview.json().messages).toEqual(oracle(1).messages);
  expect(await chat()).toEqual(before);expect(await settings()).toEqual(initialSettings);
  const sent:Record<string,unknown>[]=[];
  vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{sent.push(JSON.parse(String(init.body)));return sseResponse(["reply"]);}));
  const generated=await app.inject({method:"POST",url:`/api/conversations/${story.id}/messages`,payload:{content:"",allowEmpty:true,extensionPrompts}});
  expect(generated.statusCode,generated.body).toBe(200);expect(generated.body).toContain('"type":"macro_variables"');
  expect(sent).toHaveLength(1);expect(JSON.stringify(sent[0]!.messages)).toBe(previewText);
  expect((await chat()).chatMetadata.variables).toEqual(oracle(1).variables);
  expect((await settings()).variables.global).toEqual(oracle(1).global);
  const messageCount=(await chat()).messages.length;
  const quiet=await app.inject({method:"POST",url:`/api/conversations/${story.id}/quiet-generation`,payload:{extensionPrompts}});
  expect(quiet.statusCode,quiet.body).toBe(200);expect((await chat()).messages).toHaveLength(messageCount);
  expect((await chat()).chatMetadata.variables).toEqual(oracle(2).variables);
  expect((await settings()).variables.global).toEqual(oracle(2).global);
  const beforeDry=await chat();
  const dry=await app.inject({method:"POST",url:`/api/conversations/${story.id}/quiet-generation`,payload:{extensionPrompts,dryRun:true}});
  expect(dry.statusCode,dry.body).toBe(200);expect(dry.json().messages).toEqual(oracle(3).messages);
  expect(await chat()).toEqual(beforeDry);expect((await settings()).variables.global).toEqual(oracle(2).global);expect(sent).toHaveLength(2);
  const savedSettings=await settings();savedSettings.__mycompanion_power_user.persona_description_position=2;
  await app.inject({method:"PUT",url:"/api/extensions/settings",payload:{extensionSettings:savedSettings}});
  const skip=await app.inject({method:"POST",url:`/api/conversations/${story.id}/quiet-generation`,payload:{skipWIAN:true}});
  expect(skip.statusCode,skip.body).toBe(200);
  // skipWIAN suppresses AN insertion; later independent legacy PromptManager
  // reads remain visible, as the executed unmodified upstream trace proves.
  expect((await chat()).chatMetadata.variables).toEqual(oracle(4).variables);
  expect((await settings()).variables.global).toEqual(oracle(4).global);
  const scan=await app.inject({method:"POST",url:"/api/worldinfo/prompt",payload:{chat:[],maxContext:4096,characterId:character.id,metadata:{variables:{world:8}},globalVariables:{global:10}}});
  expect(scan.statusCode,scan.body).toBe(200);expect(scan.json().report.block).toBe("WORLD=9");
  expect((await chat()).chatMetadata.variables.world).toBe(2);
});

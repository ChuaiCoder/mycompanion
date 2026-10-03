import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { assembleModelPrompt, type PromptAssemblyOptions } from "./model-client.js";
import { productCardForTests } from "./macro-boundary-test-helper.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { countCompatibilityMessagesSync } from "./tokenizer-service.js";

function fixture(experimental:boolean,prefill=false):PromptAssemblyOptions {
  const character=productCardForTests("Actor"),conversationId=randomUUID(),branchId=randomUUID();
  const extensionSettings={__mycompanion_power_user:{experimental_macro_engine:experimental},__mycompanion_openai:{settings:{
    new_chat_prompt:"",continue_prefill:prefill,continue_nudge_prompt:"nudge={{incvar::nudge}}/{{lastChatMessage}}",
    assistant_prefill:"prefill {{incvar::prefill}}",send_if_empty:"EMPTY_USER",names_behavior:1,
    prompts:[{identifier:"main",role:"system",content:"MAIN",system_prompt:true},{identifier:"chatHistory",system_prompt:true,marker:true},
      {identifier:"jailbreak",role:"system",content:"AFTER_HISTORY",system_prompt:true}],
    prompt_order:[{character_id:100001,order:[{identifier:"main",enabled:true},{identifier:"chatHistory",enabled:true},{identifier:"jailbreak",enabled:true}]}],
  }}};
  const messages=[{role:"user"as const,content:"USER"},{role:"assistant"as const,content:"TARGET {{incvar::tail}}"}];
  return {generationType:"continue",character,settings:{kind:"anthropic",baseUrl:"http://fixture/v1",model:"claude-sonnet-4-6",maxTokens:128,contextLimitTokens:4096,temperature:0.8,hasApiKey:false},
    extensionSettings,macroSession:new MacroEvaluationSession({},extensionSettings),plugins:[],
    history:messages.map(message=>({...message,id:randomUUID(),conversationId,branchId,parentMessageId:null,status:"complete",createdAt:new Date().toISOString()})),
    extensionPrompts:[{key:"injected",value:"INJECTED",position:1,depth:0,role:2,scan:true}],
    memory:{conversationId,results:[],block:"",position:"before_recent_messages",budgetTokens:500,injectedCount:0,durationMs:0},
    lorebook:{characterId:character.id,results:[],block:"",constantBlock:"",position:"after_character_core",budgetTokens:500,injectedCount:0,durationMs:0}};
}

it.each([false,true])("moves the last real message after post-history prompts and reserves the twice-prepared nudge (experimental=%s)",experimental=>{
  const options=fixture(experimental),{messages,budget}=assembleModelPrompt(options);
  expect(messages.slice(-3).map(message=>message.content)).toEqual(["AFTER_HISTORY","TARGET 1","nudge=1/TARGET 2"]);
  expect(messages.filter(message=>message.content==="TARGET 1")).toHaveLength(1);
  expect(messages.find(message=>message.content==="INJECTED")?.role).toBe("assistant");
  expect(messages.at(-2)?.name).toBe("Actor");
  expect(options.macroSession!.local).toEqual({tail:2,nudge:1});
  expect(budget.recentMessages.at(-1)?.id).toBe(options.history.at(-1)?.id);
  expect(budget.totalTokens).toBe(countCompatibilityMessagesSync(messages.map(message=>({...message})),options.settings.model,true)+640);
});

it.each([false,true])("places Claude prefill plus the unprepared continuation target in final controls (experimental=%s)",experimental=>{
  const options=fixture(experimental,true),{messages}=assembleModelPrompt(options);
  expect(messages.at(-1)).toMatchObject({role:"assistant",name:"Actor",content:"prefill 1\n\nTARGET {{incvar::tail}}"});
  expect(messages.some(message=>message.content.startsWith("nudge="))).toBe(false);
  // The remaining assistant depth injection still triggers Tavern's empty
  // user replacement before post-history prompts; final prefill stays last.
  expect(messages.findIndex(message=>message.content==="EMPTY_USER")).toBeLessThan(messages.findIndex(message=>message.content==="AFTER_HISTORY"));
  expect(options.macroSession!.local).toEqual({prefill:1});
});

it("keeps the displaced continuation target while dropping older history under budget pressure",()=>{
  const options=fixture(true);options.history.unshift({...options.history[0]!,id:randomUUID(),content:"older ".repeat(2000)});
  options.settings.contextLimitTokens=900;
  const {messages,budget}=assembleModelPrompt(options);
  expect(messages.some(message=>message.content.startsWith("older "))).toBe(false);
  expect(messages.at(-2)?.content).toBe("TARGET 1");
  expect(budget.totalTokens).toBeLessThanOrEqual(options.settings.contextLimitTokens);
});

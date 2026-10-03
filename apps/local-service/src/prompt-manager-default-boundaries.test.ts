import { expect, it } from "vitest";
import { parseCompletionExample, parseCompatibleCompletionExample } from "./prompt-manager-core.js";
import { assembleModelPrompt, type PromptAssemblyOptions } from "./model-client.js";
import { MacroEvaluationSession } from "./prompt-macros.js";
import { productCardForTests } from "./native-fixtures.js";
import reference from "./fixtures/prompt-persona-examples-upstream-reference.json" with { type: "json" };
import { countCompatibilityMessagesSync } from "./tokenizer-service.js";

it("retains exact Tavern English speaker grouping and confines full-width fallback to known names", () => {
  const english = "<START>\nUser: hello\nUser: again\nActor: welcome\ncontinuation\nUser: thanks";
  expect(parseCompatibleCompletionExample(english,"User","Actor")).toEqual(parseCompletionExample(english,"User","Actor"));
  expect(parseCompletionExample("<START>\nActor：hello","User","Actor")).toEqual([]);
  expect(parseCompatibleCompletionExample("<START>\nActor：hello\nUser：thanks","User","Actor"))
    .toEqual([{role:"system",content:"hello",name:"example_assistant"},{role:"system",content:"thanks",name:"example_user"}]);
  expect(parseCompatibleCompletionExample("<START>\nUnknown：hello","User","Actor")).toEqual([]);
});

const fixture = (experimental: boolean): PromptAssemblyOptions => {
  const character=productCardForTests("Astronomer"); character.exampleDialogue="<START>\nAstronomer: ORIGINAL";
  const extensionSettings={__mycompanion_power_user:{experimental_macro_engine:experimental}};
  return { character, settings:{kind:"ollama",baseUrl:"http://provider.test/v1",model:"gpt-4o",maxTokens:128,contextLimitTokens:4096,temperature:0.7,hasApiKey:false},
    extensionSettings, macroSession:new MacroEvaluationSession({},extensionSettings),plugins:[],history:[],
    memory:{conversationId:character.id,results:[],block:"",position:"before_recent_messages",budgetTokens:500,injectedCount:0,durationMs:0},
    lorebook:{characterId:character.id,results:[5,6].map((position,index)=>({index,name:"example",status:"injected",matchedKey:null,tokens:0,diagnostics:[],
      content:`<START>\nAstronomer: ${position===5?"TOP":"BOTTOM"}={{incvar::exampleRuns}}`,position})),block:"",constantBlock:"",position:"after_character_core",budgetTokens:500,injectedCount:2,durationMs:0} };
};
it.each([false,true])("places WI example messages in their independent upstream base replacement phase (experimental=%s)",experimental=>{
  const options=fixture(experimental),actual=assembleModelPrompt(options);
  const oracle=reference.runs.find(run=>run.mode==="world-info-examples"&&run.experimental===experimental)!;
  const examples=actual.messages.filter(message=>message.name?.startsWith("example_"));
  expect(examples).toEqual(oracle.examples!.flat()); expect(options.macroSession!.local).toEqual(oracle.variables);
  expect(actual.budget.totalTokens).toBe(countCompatibilityMessagesSync(actual.messages.map(message=>({...message})),"gpt-4o",true)+640);
  expect(actual.budget.regions.find(region=>region.key==="example_dialogue")?.content).toContain("TOP=1");
});

it("reports only emitted regions when the chat-history marker is disabled",()=>{
  const options=fixture(true);
  options.extensionSettings={...options.extensionSettings,__mycompanion_openai:{settings:{prompt_order:[{character_id:100001,order:[{identifier:"main",enabled:true},{identifier:"chatHistory",enabled:false}]}]}}};
  options.stageSummary="must not be sent";
  const actual=assembleModelPrompt(options);
  expect(actual.messages.some(message=>message.content.includes("must not be sent"))).toBe(false);
  expect(actual.budget.regions.some(region=>region.key==="stage_summary")).toBe(false);
  expect(actual.budget.regions.some(region=>region.label==="新聊天标记")).toBe(false);
});

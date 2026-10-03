import { describe, expect, it, vi } from "vitest";
import { resolveMacros } from "./prompt-macros.js";
import { browserMacroHarness as harness } from "./browser-macro-test-helper.js";

// Execute the exact served source. Electron fixtures separately exercise its
// real ESM graph, document, queues and SQLite persistence.

describe("character card macro environments",()=>{
  it("evaluates all card fields in Tavern eager order for every nonempty legacy invocation",()=>{
    const h=harness(),order:string[]=[],character=h.context.characters[0]!;
    const field=(name:string)=>{
      h.MacrosParser.registerLegacyMacro("cardPhase"+name,()=>{order.push(name);return h.variables.getLocalVariable("phase");});
      return "{{incvar::phase}}{{cardPhase"+name+"}}";
    };
    Object.assign(character.data,{system_prompt:field("System"),mes_example:field("Examples"),description:field("Description"),
      personality:field("Personality"),scenario:field("Scenario"),post_history_instructions:field("Jailbreak"),
      character_version:"{{incvar::phase}}",extensions:{depth_prompt:{prompt:field("Depth")}},creator_notes:field("Notes"),
      first_mes:field("First"),alternate_greetings:[field("Alternate")]});
    h.powerUser.persona_description=field("Persona");
    expect(h.substituteParams("")).toBe("");expect(order).toEqual([]);
    expect(h.substituteParams("plain text")).toBe("plain text");
    expect(order).toEqual(["System","Examples","Description","Personality","Persona","Scenario","Jailbreak","Depth","Notes","First","Alternate"]);
    expect(h.variables.getLocalVariable("phase")).toBe(11);
    expect(h.substituteParams("{{description}}/{{description}}")).toBe("1414/1414");
    expect(h.variables.getLocalVariable("phase")).toBe(22);
    expect(order).toHaveLength(22);
  });
  it("keeps the new engine lazy, caches each field only inside one invocation and defaults card replacement on",()=>{
    const h=harness();h.powerUser.experimental_macro_engine=true;
    Object.assign(h.context.characters[0]!.data,{description:"{{incvar::phase}}",personality:"{{incvar::phase}}",system_prompt:"{{incvar::phase}}"});
    expect(h.substituteParams("plain text")).toBe("plain text");expect(h.variables.getLocalVariable("phase")).toBe("");
    expect(h.substituteParams("{{description}}/{{description}}")).toBe("1/1");expect(h.variables.getLocalVariable("phase")).toBe(1);
    expect(h.substituteParams("{{description}}/{{personality}}")).toBe("2/3");expect(h.variables.getLocalVariable("phase")).toBe(3);
    expect(h.substituteParams("{{description}}",{replaceCharacterCard:false})).toBe("");expect(h.variables.getLocalVariable("phase")).toBe(3);
    h.context.characters[0]!.data.mes_example="<START>\n{{incvar::phase}}";
    expect(h.substituteParams("{{mesExamplesRaw}}|{{mesExamples}}")).toBe("<START>\n4|<START>\n4\n");
    expect(h.variables.getLocalVariable("phase")).toBe(4);
    expect(h.substituteParams("{{description}}",{dynamicMacros:{description:"dynamic"}})).toBe("dynamic");expect(h.variables.getLocalVariable("phase")).toBe(4);
    h.powerUser.prefer_character_prompt=false;h.powerUser.prefer_character_jailbreak=false;
    h.context.characters[0]!.data.post_history_instructions="{{incvar::phase}}";
    expect(h.substituteParams("{{charPrompt}}/{{charInstruction}}")).toBe("/");expect(h.variables.getLocalVariable("phase")).toBe(4);
  });
  it("provides all legacy card aliases, parsed examples and default names with recursion disabled for card text",()=>{
    const h=harness(),data=h.context.characters[0]!.data;
    Object.assign(data,{system_prompt:"system",post_history_instructions:"jail",description:"{{char}}/{{description}}",personality:"patient",scenario:"forest",
      mes_example:"<START>\n{{user}}: hello\n{{char}}: welcome",character_version:"v2",extensions:{depth_prompt:{prompt:"depth"}},creator_notes:"notes"});
    h.powerUser.persona_description="persona";
    expect(h.substituteParams("{{charPrompt}}|{{charInstruction}}|{{charJailbreak}}|{{description}}|{{personality}}|{{scenario}}|{{persona}}|{{mesExamples}}|{{mesExamplesRaw}}|{{charVersion}}|{{char_version}}|{{charDepthPrompt}}|{{creatorNotes}}",{name2Override:"Outer"})).toBe(
      "system|jail|jail|Actor/{{description}}|patient|forest|persona|<START>\nReader: hello\nActor: welcome\n|<START>\nReader: hello\nActor: welcome|v2|v2|depth|notes");
    expect(h.substituteParams("{{description}}/{{char}}",{replaceCharacterCard:false,name2Override:"Outer"})).toBe("{{description}}/Outer");
  });
  it("retains the separate lazy evaluation when a registered bridge explicitly reads character fields",()=>{
    const h=harness();h.context.characters[0]!.data.description="{{incvar::phase}}";
    h.registry.registerMacro("browserCardBridge",{handler:({env}:any)=>env.character.description});
    try{
      expect(h.substituteParams("{{description}}/{{browserCardBridge}}/{{browserCardBridge}}")).toBe("1/2/2");
      expect(h.variables.getLocalVariable("phase")).toBe(2);
      expect(h.substituteParams("{{description}}/{{browserCardBridge}}")).toBe("3/4");
      expect(h.variables.getLocalVariable("phase")).toBe(4);
    }finally{h.registry.unregisterMacro("browserCardBridge");}
  });
  it("applies metadata, preference, collapse and CR rules before dynamic and registered overrides",()=>{
    const h=harness(),data=h.context.characters[0]!.data;
    Object.assign(data,{system_prompt:"card",post_history_instructions:"jail",description:" \r\n{{incvar::phase}}\r\n\n\ntext\r\n ",mes_example:"card examples",scenario:"card scenario"});
    Object.assign(h.context.chatMetadata,{system_prompt:"metadata system",mes_example:"metadata examples",scenario:"metadata scenario"});
    h.powerUser.collapse_newlines=true;
    expect(h.substituteParams("{{charPrompt}}|{{charInstruction}}|{{description}}|{{mesExamplesRaw}}|{{scenario}}")).toBe("metadata system|jail|1\ntext|metadata examples|metadata scenario");
    h.powerUser.prefer_character_prompt=false;h.powerUser.prefer_character_jailbreak=false;
    expect(h.substituteParams("{{charPrompt}}|{{charJailbreak}}")).toBe("|");
    expect(h.variables.getLocalVariable("phase")).toBe(2);
    expect(h.substituteParams("{{description}}",{dynamicMacros:{description:"dynamic"}})).toBe("dynamic");expect(h.variables.getLocalVariable("phase")).toBe(3);
    h.MacrosParser.registerLegacyMacro("description","registered");
    expect(h.substituteParams("{{description}}",{dynamicMacros:{description:"dynamic"}})).toBe("registered");expect(h.variables.getLocalVariable("phase")).toBe(4);
  });
});

describe("legacy extension macros",()=>{
  it("bridges the complete invocation environment without double postprocessing or reentrant leakage",()=>{
    const h=harness(),seen:Array<{content:string;nonce:string}>=[];
    h.registry.registerMacro("bridgeReview",{handler:({env}:any)=>{
      seen.push({content:env.content,nonce:env.extra.nonce});
      if(env.names.char==="Outer")expect(h.substituteParams("{{bridgeReview}}",{name2Override:"Inner"})).toBe("Inner/256");
      return env.names.char+"/"+(env.dynamicMacros.maxresponse??env.extra.maxResponse);
    }});
    try{
      const text="A{{bridgeReview}}B{{bridgeReview}}C";
      expect(h.substituteParams(text,{name2Override:"Outer",dynamicMacros:{maxResponse:96},postProcessFn:(v:string)=>"["+v+"]"})).toBe("A[Outer/96]B[Outer/96]C");
      expect(seen.filter(x=>x.content===text)).toHaveLength(2);
      expect(seen).toHaveLength(4);
      expect(seen[0]!.nonce).toBe(seen[2]!.nonce);
      expect(seen[0]!.nonce).not.toBe(seen[1]!.nonce);
    }finally{h.registry.unregisterMacro("bridgeReview");}
  });
  it("shares one-shot original across bridged and legacy replacements",()=>{
    const h=harness();h.registry.registerMacro("bridgeOriginal",{handler:({env}:any)=>env.functions.original?.()??""});
    try{expect(h.substituteParams("{{bridgeOriginal}}/{{original}}/{{bridgeOriginal}}",{original:"once"})).toBe("/once/");}
    finally{h.registry.unregisterMacro("bridgeOriginal");}
  });
  it("evaluates parameterized parser semantics in the served browser engine",()=>{
    const h=harness();h.powerUser.experimental_macro_engine=true;
    h.variables.setLocalVariable("flag", "1");
    const text="{{if {{getvar::flag}}}}{{reverse::{{char}}}}/{{maxPrompt}}/{{space::2}}{{else}}wrong{{/if}}";
    expect(h.substituteParams(text)).toBe("rotcA/3840/");
    expect(h.substituteParams("{{maxPrompt}}/{{maxResponse}}",{dynamicMacros:{maxPrompt:4000,maxResponse:96}})).toBe("4000/96");
  });
  it("matches native localized and ISO time macros in the same fixed minute",()=>{
    const now=new Date(2026,8,20,9,5,7);
    vi.useFakeTimers();vi.setSystemTime(now);
    try {
      const text="{{date}}|{{time}}|{{weekday}}|{{isodate}}|{{isotime}}";
      expect(harness().substituteParams(text)).toBe(resolveMacros(text,{characterName:"Actor",now,locale:"zh-CN"}));
    } finally {vi.useRealTimers();}
  });
  it("shares a nonce per evaluation, calls every occurrence and normalizes registry values",()=>{
    const h=harness(), nonces:string[]=[];
    h.MacrosParser.registerMacro(" probe ",(nonce:string)=>{nonces.push(nonce);return {count:nonces.length};},"description");
    expect(h.substituteParams("{{probe}}/{{PROBE}}")).toBe('{"count":1}/{"count":2}');
    expect(nonces[0]).toBe(nonces[1]);
    h.substituteParams("{{probe}}");expect(nonces[2]).not.toBe(nonces[0]);
    expect([...h.MacrosParser]).toEqual([{key:"probe",description:"description"}]);
    for(const [key,value] of Object.entries({nil:null,date:new Date("2026-01-01T00:00:00Z"),promise:Promise.resolve(1),number:42}))h.MacrosParser.registerMacro(key,value);
    expect(h.substituteParams("{{nil}}|{{date}}|{{promise}}|{{number}}")).toBe('|2026-01-01T00:00:00.000Z||42');
    h.MacrosParser.unregisterMacro(" probe ");expect(h.MacrosParser.has("probe")).toBe(false);
    expect(()=>h.MacrosParser.registerMacro("{{bad}}","x")).toThrow();
    expect(()=>h.MacrosParser.registerMacro(" ","x")).toThrow();
  });
  it("honors registry precedence, literal names, one-pass ordering and original once",()=>{
    const h=harness();h.MacrosParser.registerMacro("a+b","$&");h.MacrosParser.registerMacro("user","registered");
    expect(h.substituteParamsExtended("{{a+b}} {{user}}",{user:"dynamic"})).toBe("$& registered");
    expect(h.substituteParams("{{original}}|{{original}}|{{char}}",{original:"{{char}}",name2Override:"A"})).toBe("A||A");
    expect(h.substituteParams("{{original}} {{char}}",undefined,"Legacy","text")).toBe("text Legacy");
    expect(h.substituteParamsExtended("{{first}}|{{second}}",{first:"{{second}}",second:"{{first}}"})).toBe("{{first}}|{{first}}");
    expect(h.substituteParams("{{unknown}} {{if::x}} {{char}}",{name2Override:"$1"})).toBe("{{unknown}} {{if::x}} $1");
  });
  it("postprocesses each replacement and retains the entire failing pass",()=>{
    const h=harness();let calls=0;
    h.MacrosParser.registerMacro("bad",()=>{if(++calls===2)throw Error("expected");return "changed";});
    expect(h.substituteParamsExtended("{{bad}} {{bad}}/{{char}}",{},(value:string)=>'['+value+']')).toBe("{{bad}} {{bad}}/[Actor]");
    expect(h.warning).toHaveBeenCalledOnce();
    expect(h.substituteParams("<USER>/<BOT>\n{{trim}}\n{{reverse:😀ab}}{{//hidden}}/{{newline}}/{{noop}}")).toBe("Reader/Actorba😀/\n/");
  });
  it("finds completed and filtered messages while swipe macros include the pending swipe",()=>{
    const h=harness();h.context.chat.push({mes:"user",is_user:true},{mes:"bot"},{mes:"system",is_system:true},{mes:"pending",swipes:["old"],swipe_id:1});
    expect(h.getLastMessageId()).toBe(2);
    expect(h.getLastMessageId({filter:(m:{is_user:boolean})=>m.is_user})).toBe(0);
    expect(h.substituteParams("{{lastMessage}}|{{lastUserMessage}}|{{lastCharMessage}}|{{lastMessageId}}|{{lastSwipeId}}|{{currentSwipeId}}|{{allChatRange}}|{{maxPrompt}}")).toBe("system|user|bot|2|1|2|0-3|3840");
    h.context.chat.length=0;expect(h.getLastMessageId()).toBeNull();
    expect(h.substituteParams("{{lastMessage}}|{{currentSwipeId}}|{{allChatRange}}")).toBe("||");
  });
  it("executes variable operation passes in Tavern order rather than source order",()=>{
    const h=harness();
    expect(h.substituteParams("{{getvar::x}}/{{incvar::x}}/{{setvar::x::4}}{{addvar::x::2}}{{decvar::x}}/{{getvar::x}}/{{setglobalvar::g::8}}{{incglobalvar::g}}")).toBe("6/7/6/6/9");
    expect(h.context.chatMetadata.variables).toEqual({x:6});
    expect(h.variables.getGlobalVariable("g")).toBe(9);
    expect(h.localSave).toHaveBeenCalledTimes(4);expect(h.globalSave).toHaveBeenCalledTimes(2);
  });
  it("supports JSON indices, conversions, array append, string addition and scoped resolution",()=>{
    const h=harness(),v=h.variables;
    v.setLocalVariable("list","7",{index:0,as:"number"});v.addLocalVariable("list","x");
    expect(v.getLocalVariable("list")).toBe('[7,"x"]');expect(v.getLocalVariable("list",{index:0})).toBe(7);
    v.setGlobalVariable("object",'{"a":1}',{index:"entry",as:"object"});expect(v.getGlobalVariable("object",{index:"entry"})).toBe('{"a":1}');
    v.setLocalVariable("space"," ");expect(v.getLocalVariable("space")).toBe(" ");
    v.setLocalVariable("word","A");v.addLocalVariable("word","B");expect(v.getLocalVariable("word")).toBe("AB");
    v.setGlobalVariable("word","global");expect(v.resolveVariable("word")).toBe("AB");
    expect(v.resolveVariable("word",{existsVariable:()=>true,getVariable:()=>"scope"})).toBe("scope");
    v.deleteLocalVariable("word");expect(v.resolveVariable("word")).toBe("global");v.deleteGlobalVariable("word");expect(v.resolveVariable("word")).toBe("word");
  });
  it("keeps variable names as own data, including prototype-looking keys, without polluting objects",()=>{
    const h=harness(),v=h.variables;
    expect(v.existsLocalVariable("constructor")).toBe(false);
    v.setLocalVariable("__proto__","data");expect(v.getLocalVariable("__proto__")).toBe("data");
    v.setLocalVariable("obj","value",{index:"__proto__"});expect(v.getLocalVariable("obj")).toBe('{"__proto__":"value"}');
    h.MacrosParser.registerMacro("__proto__","safe");expect(h.substituteParams("{{__proto__}}")).toBe("safe");
    expect(Object.prototype).not.toHaveProperty("value");
  });
  it("reads local variables from the currently bound chat on every invocation",()=>{
    const h=harness();h.variables.setLocalVariable("x","one");h.variables.setGlobalVariable("x","shared");
    const first=h.context.chatMetadata;h.context.chatMetadata={};
    expect(h.variables.getLocalVariable("x")).toBe("");expect(h.variables.getGlobalVariable("x")).toBe("shared");
    h.variables.setLocalVariable("x","two");h.context.chatMetadata=first;expect(h.variables.getLocalVariable("x")).toBe("one");
  });
});

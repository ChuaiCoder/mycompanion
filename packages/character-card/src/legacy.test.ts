import { describe,expect,it } from "vitest";
import { parseCharacterCardDocument } from "./parse.js";
import { encodeCharacterCardPng,parseCharacterCardPngDocument } from "./png.js";

describe("legacy card migration",()=>{
  it("converts V1 fields, tags, extensions and book while retaining foreign metadata through V2 JSON and PNG",()=>{
    const raw={name:"旧卡角色",description:"description",personality:"patient",scenario:"workshop",first_mes:"Welcome {{user}}.",mes_example:"<START>\n{{char}}: Hello.",
      creator_notes:"notes",tags:"one, two,",creator:"MyCompanion",talkativeness:0,alternate_greetings:"alternate",
      depth_prompt_prompt:"DEPTH",depth_prompt_depth:2,depth_prompt_role:"assistant",foreign:{retained:true},
      extensions:{regex_scripts:[{scriptName:"test",findRegex:"/a/g",replaceString:"b",placement:[2]}]},
      character_book:{entries:[{keys:["shop"],content:"book",enabled:true,insertion_order:1,extensions:{}}]}};
    const parsed=parseCharacterCardDocument(raw); expect(parsed.preview.format).toBe("tavern-v1-json");
    expect(parsed.preview.warningCodes).toContain("legacy_format_converted");
    expect(parsed.card).toMatchObject({foreign:raw.foreign,data:{name:raw.name,first_mes:raw.first_mes,tags:["one","two"],alternate_greetings:["alternate"],
      extensions:{talkativeness:0,depth_prompt:{prompt:"DEPTH",depth:2,role:"assistant"}}}});
    expect(parsed.preview.lorebookEntryCount).toBe(1);expect(parsed.preview.regexScriptCount).toBe(1);
    expect(parseCharacterCardDocument(JSON.parse(JSON.stringify(parsed.card))).card).toEqual(parsed.card);
    expect(parseCharacterCardPngDocument(encodeCharacterCardPng(parsed.card)).card).toEqual(parsed.card);
  });
  it("maps Pygmalion Gradio fields without silently deleting their originals",()=>{
    const raw={char_name:"Pygmalion",char_persona:"persona",char_greeting:"greeting",world_scenario:"scenario",example_dialogue:"examples",unknown:[1,2]};
    const parsed=parseCharacterCardDocument(raw);expect(parsed.preview.format).toBe("pygmalion-json");
    expect(parsed.card).toMatchObject({...raw,data:{name:raw.char_name,description:raw.char_persona,first_mes:raw.char_greeting,scenario:raw.world_scenario,mes_example:raw.example_dialogue}});
  });
  it("keeps declared spec validation and does not accept arbitrary or malformed legacy input",()=>{
    for(const raw of [{spec:"chara_card_v2",name:"legacy",data:{}},{spec:"unsupported",name:"legacy"},{name:123},{char_name:123},{unknown:true},null])
      expect(()=>parseCharacterCardDocument(raw)).toThrow();
    expect(()=>parseCharacterCardDocument({name:"bad tags",tags:1})).toThrow();
  });
});

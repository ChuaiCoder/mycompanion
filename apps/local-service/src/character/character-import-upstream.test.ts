import { readFileSync } from "node:fs";
import { ZipFile } from "yazl";
import { describe,expect,it } from "vitest";
import { parseCharacterCardDocument } from "@mycompanion/character-card";
import { parseCharacterCardYaml } from "./character-yaml.js";
import { parseCharacterByaf } from "./character-byaf.js";

const reference=JSON.parse(readFileSync(new URL("./fixtures/character-import-upstream-reference.json",import.meta.url),"utf8"));
const core=(data:Record<string,unknown>,expected:Record<string,unknown>)=>Object.fromEntries(Object.keys(expected).map(key=>[key,data[key]]));
async function archive(input:{manifest?:Record<string,unknown>;character?:Record<string,unknown>;scenarios:Array<Record<string,unknown>>}){
  const zip=new ZipFile(),parts:Buffer[]=[];
  const done=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on("data",part=>parts.push(part));zip.outputStream.on("error",reject);zip.outputStream.on("end",()=>resolve(Buffer.concat(parts)));});
  const scenarios=input.scenarios.map((_,index)=>`scenarios/${index}.json`);
  zip.addBuffer(Buffer.from(JSON.stringify({...input.manifest,characters:["characters/import/character.json"],scenarios})),"manifest.json");
  zip.addBuffer(Buffer.from(JSON.stringify(input.character??{name:"BYAF Guide"})),"characters/import/character.json");
  input.scenarios.forEach((scenario,index)=>zip.addBuffer(Buffer.from(JSON.stringify(scenario)),scenarios[index]!));
  zip.end();return done;
}
describe("actual fixed ST legacy/YAML/BYAF execution outputs",()=>{
  it.each(reference.cases.slice(0,4) as Array<{input:unknown;expectedCore:Record<string,unknown>;name:string}>)("matches $name core fields and preserves extra input",({input,expectedCore,name})=>{
    const parsed=name==="yaml"?parseCharacterCardYaml(String(input)):parseCharacterCardDocument(input);
    expect(core(parsed.card.data,expectedCore)).toEqual(expectedCore);
    if(name!=="v1-missing")expect((parsed.card as Record<string,unknown>).foreign).toEqual({retained:true});
  });
  it("matches real BYAF card/macro/book/greeting conversion through bounded archive parsing",async()=>{
    const fixture=reference.cases.find((item:{name:string})=>item.name==="byaf-card");
    const parsed=await parseCharacterByaf(await archive(fixture.input));
    expect(core(parsed.card.data,fixture.expectedCore)).toEqual(fixture.expectedCore);
    expect(parsed.card.data.alternate_greetings).toEqual(fixture.alternateGreetings);
    expect(parsed.card.data.character_book).toEqual(fixture.characterBook);
    expect(parsed.card.data.system_prompt).toBe(fixture.systemPrompt);
  });
  it("matches actual upstream message order, active output and all swipes through the importer",async()=>{
    const fixture=reference.cases.find((item:{name:string})=>item.name==="byaf-chat");
    const parsed=await parseCharacterByaf(await archive({scenarios:[fixture.input]}));
    const actual=parsed.byafScenarios[0]!.chat.slice(1).map(message=>({role:message.is_user?"user":"assistant",content:message.mes,
      ...(message.swipes?{swipes:message.swipes,swipeId:message.swipe_id}: {})}));
    expect(actual).toEqual(fixture.expectedMessages);
  });
});

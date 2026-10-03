import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSlashFixture } from "./slash-runtime-fixture.js";

const messages = [
  {name:"Reader",is_user:true,is_system:false,mes:"User line"},
  {name:"Actor",is_user:false,is_system:false,mes:"First reply"},
  {name:"Narrator",is_user:false,is_system:true,mes:"Hidden narration",extra:{type:"narrator"}},
  {name:"Actor",is_user:false,is_system:false,mes:"Last reply"},
];
const cases = ['/messages names=off hidden=on 0-3', '/message names=on hidden=off role=assistant 0-3',
  '/messages names=off hidden=on role=system 0-3', '/messages names=off hidden=on role=user 0-3',
  '/messages names=off hidden=off 2', '/messages 4', '/messages 3-1',
  '/messages names=off hidden=on role=invalid 0-3', '/setinput Draft from slash | /pass {{pipe}}'];
describe("original input and history slash commands", () => {
  it("filters real host message roles/hidden ranges and preserves the message alias", async () => {
    const h=await createSlashFixture(); try {
      h.context.chat.push(...structuredClone(messages));
      const run=(text:string)=>h.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false,handleExecutionErrors:false});
      expect((await run(cases[0]!)).pipe).toBe("User line\n\nFirst reply\n\nHidden narration\n\nLast reply");
      expect((await run(cases[1]!)).pipe).toBe("Actor: First reply\n\nActor: Last reply");
      expect((await run(cases[2]!)).pipe).toBe("Hidden narration");
      expect((await run(cases[3]!)).pipe).toBe("User line");
      for (const text of cases.slice(4,7)) expect((await run(text)).pipe).toBe("");
      await expect(run(cases[7]!)).rejects.toThrow(/Invalid role/);
      expect(h.context.chat).toEqual(messages);
      expect(h.traces.filter(item=>/Save|render|send/.test(item[0]))).toEqual([]);
    } finally { h.close(); }
  });
  it("sets the composer through the original bubbling input event and preserves the pipe", async () => {
    const h=await createSlashFixture();try {
      expect((await h.api.executeSlashCommandsWithOptions(cases[8]!)).pipe).toBe("Draft from slash");
      expect(h.textarea.value).toBe("Draft from slash");
      expect(h.traces).toContainEqual(["input","Draft from slash","input",true]);
      expect(h.context.chat).toEqual([]);
    }finally{h.close();}
  });
});

const originalRoot=process.env.SILLYTAVERN_SLASH_ORACLE_ROOT;
describe.skipIf(!originalRoot)("fixed pristine input/history command oracle",()=>{
  it("compares actual original parser registrations and unchanged callbacks in both engines",async()=>{
    const records=[];
    for(const experimental of [false,true])for(const text of cases){
      const original=await createSlashFixture(originalRoot),actual=await createSlashFixture();
      try{
        for(const h of [original,actual]){h.power_user.experimental_macro_engine=experimental;h.context.chat.push(...structuredClone(messages));}
        const run=async(h:typeof actual)=>{try{return {pipe:(await h.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false,handleExecutionErrors:false})).pipe,input:h.textarea.value,traces:h.traces};}
          catch(error:any){return {error:{name:error.name,message:error.message},input:h.textarea.value,traces:h.traces};}};
        const expected=await run(original),observed=await run(actual);expect(observed).toEqual(expected);records.push({experimental,text,expected,observed});
      }finally{original.close();actual.close();}
    }
    const path=process.env.MYCOMPANION_SLASH_INPUT_ORACLE_REPORT;
    if(path){const report=resolve(path);mkdirSync(dirname(report),{recursive:true});
      writeFileSync(report,JSON.stringify({passed:true,scope:"18 original input/history executions",upstreamCommit:"7e8663cd9c184a550b37238218bdd32c6efc68e9",
        sourceHashes:["public/scripts/slash-commands.js","public/scripts/utils.js"].map(path=>({path,sha256:createHash("sha256").update(readFileSync(resolve(originalRoot!,path))).digest("hex")})),records},null,2)+"\n",{flag:"wx"});}
  });
});

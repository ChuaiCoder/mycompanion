import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { scriptDataSource } from "./plugin-runtime-script-data.js";
import { createCharacterMacroFieldsLazy, readCharacterMacroFields } from "@mycompanion/shared";

it("resolves each lazy character field only when read and caches side effects per snapshot",()=>{
  const substituteParams=vi.fn((text:string)=>text.replace("{{effect}}","once"));
  const runtime=runInNewContext(scriptDataSource.replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"")+
    "\n;({getCharacterCardFieldsLazy})",{
      getContext:()=>({characters:[{description:"{{effect}}",personality:"patient",data:{}}],characterId:0,chatMetadata:{}}),
      substituteParams,power_user:{},oai_settings:{},
      createCharacterMacroFieldsLazy,readCharacterMacroFields,
    });
  const fields=runtime.getCharacterCardFieldsLazy();expect(substituteParams).not.toHaveBeenCalled();
  expect(fields.description).toBe("once");expect(fields.description).toBe("once");expect(substituteParams).toHaveBeenCalledOnce();
  expect(fields.personality).toBe("patient");expect(substituteParams).toHaveBeenCalledTimes(2);
  expect(runtime.getCharacterCardFieldsLazy().description).toBe("once");expect(substituteParams).toHaveBeenCalledTimes(3);
});

import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerPluginRuntimeAssets } from "./plugin-runtime-assets.js";

it("serves public macro entry points at both canonical and runtime paths",async()=>{
  const app=Fastify();registerPluginRuntimeAssets(app);
  try{
    for(const path of ["macros/macro-system.js","macros/engine/MacroEnvBuilder.js"]){
      const canonical=await app.inject({url:"/scripts/"+path});
      const runtime=await app.inject({url:"/plugin-runtime/scripts/"+path});
      expect(canonical.statusCode).toBe(200);expect(runtime.statusCode).toBe(200);
      expect(runtime.body).toBe(canonical.body);expect(canonical.headers["content-type"]).toContain("javascript");
    }
  }finally{await app.close();}
});

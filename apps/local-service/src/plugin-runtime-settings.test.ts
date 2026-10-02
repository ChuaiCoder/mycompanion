import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { extensionSettingsSource } from "./plugin-runtime-settings.js";
import { macroVariableSyncSource } from "./plugin-runtime-macro-variable-sync.js";
import { mergeJsonChanges } from "@mycompanion/shared";

it.each([{}, { variables: { global: { kept: 7 }, extra: true } }])("hydrates the global variable namespace without depending on a slash command", async settings => {
  const source = extensionSettingsSource.replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
  const runtime = runInNewContext(source + "\n({loadExtensionSettings,extension_settings})", {
    window: {}, isMacroDraftActive:()=>false, fetch: async () => ({ ok: true, json: async () => ({ extensionSettings: structuredClone(settings) }) }),
  });
  await runtime.loadExtensionSettings();
  expect(runtime.extension_settings.variables.global).toEqual('variables' in settings ? settings.variables.global : {});
  if ('variables' in settings) expect(runtime.extension_settings.variables.extra).toBe(true);
});

it("keeps native global deltas through queued stale saves and retries failed local patches",async()=>{
  let server:Record<string,any>={variables:{global:{counter:0}}},fail=false;
  const source=extensionSettingsSource.replace(/^import .*;\r?\n/gm,"").replace(/export /g,"");
  const sync=macroVariableSyncSource.replace(/export /g,"");
  const runtime=runInNewContext(sync+source+"\n({loadExtensionSettings,extension_settings,saveSettings,applyGlobalMacroChanges})",{
    window:{clearTimeout,setTimeout},isMacroDraftActive:()=>false,structuredClone,fetch:async(_url:string,options?:{body:string})=>{
      if(!options)return {ok:true,json:async()=>({extensionSettings:structuredClone(server)})};
      if(fail){fail=false;throw Error("expected network failure");}
      for(const patch of JSON.parse(options.body).patches)server=mergeJsonChanges(patch.base,patch.next,server) as Record<string,any>;
      return {ok:true};
    },
  });
  await runtime.loadExtensionSettings();
  runtime.extension_settings.other="first";const oldSave=runtime.saveSettings();
  server.variables.global.counter=1;
  runtime.applyGlobalMacroChanges([{scope:"global",key:"counter",beforeExists:true,before:0,afterExists:true,after:1}]);
  await oldSave;await runtime.saveSettings();
  expect(server).toEqual({variables:{global:{counter:1}},other:"first"});
  fail=true;runtime.extension_settings.failedKey="keep";await expect(runtime.saveSettings()).rejects.toThrow("expected network failure");
  runtime.extension_settings.other="second";await runtime.saveSettings();
  expect(server).toEqual({variables:{global:{counter:1}},other:"second",failedKey:"keep"});
});

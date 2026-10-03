import { describe,expect,it } from "vitest";
import { createSlashFixture } from "./slash-runtime-fixture.js";
import { createHash } from "node:crypto";
import { readFileSync,writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import {parse as parseJavaScript} from "acorn";
import Fastify from "fastify";
import { registerPluginRuntimeAssets } from "./plugin-runtime-assets.js";

describe("reused Tavern slash execution",()=>{
  it("executes original text/regex commands, aliases, global captures and regex failure semantics",async()=>{
    const h=await createSlashFixture();try{
      const run=(text:string)=>h.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false});
      expect((await run('/to-upper Abc | /lower {{pipe}}')).pipe).toBe("abc");
      expect((await run('/substring start=-3 end=-1 morning')).pipe).toBe("in");
      expect((await run('/replace pattern=blue replacer=red Blue house blue car')).pipe).toBe("Blue house red car");
      expect((await run('/re mode=regex pattern="/blue/gi" replacer=red Blue house blue car')).pipe).toBe("red house red car");
      expect((await run('/match pattern="/x([0-9])/g" x1x2')).pipe).toBe('[["x1","1"],["x2","2"]]');
      expect((await run('/match pattern=orange blue')).pipe).toBe("");
      expect((await run('/match pattern="/orange/g" blue')).pipe).toBe("[]");
      expect((await run('/test pattern="/foo/gg" foo')).pipe).toBe("false");
      expect((await run('/test pattern="/foo/gg" /foo/gg')).pipe).toBe("true");
      expect(await h.api.executeSlashCommandsWithOptions('/test pattern="/[ /" text',{handleExecutionErrors:true})).toMatchObject({isError:true});
    }finally{h.close();}
  });
  it("serves runtime aliases as canonical re-exports instead of instantiating duplicate classes",async()=>{
    const app=Fastify();registerPluginRuntimeAssets(app);try{
      for(const path of ['slash-commands.js','slash-commands/SlashCommandParser.js','slash-commands/SlashCommandClosure.js']){
        const canonical=await app.inject({url:'/scripts/'+path}),runtime=await app.inject({url:'/plugin-runtime/scripts/'+path});
        expect(canonical.statusCode).toBe(200);expect(runtime.statusCode).toBe(200);
        expect(runtime.body).toBe("export * from '/scripts/"+path+"';");expect(canonical.body).not.toBe(runtime.body);
        expect(runtime.headers['content-type']).toContain('javascript');expect(runtime.headers['cache-control']).toBe('no-store');
      }
    }finally{await app.close();}
  });
  it("passes pipes, escaped delimiters, comments and case-sensitive registered aliases",async()=>{
    const h=await createSlashFixture();try{
      const {api}=h;
      api.SlashCommandParser.addCommandObject(api.SlashCommand.fromProps({name:"CaseCommand",aliases:["CaseAlias"],callback:(_args:any,text:string)=>text+"!"}));
      expect((await api.executeSlashCommandsWithOptions('/CaseAlias hello | /pass {{pipe}}')).pipe).toBe("hello!");
      expect((await api.executeSlashCommandsWithOptions('/pass left\\|right | /pass {{pipe}}')).pipe).toBe("left|right");
      expect((await api.executeSlashCommandsWithOptions('/# comment | /pass A | /pass {{pipe}} B')).pipe).toBe("A B");
      await expect(api.executeSlashCommandsWithOptions('/casealias nope',{handleParserErrors:false})).rejects.toThrow();
      expect(api.registeredCommand("CaseAlias").callback).toBeTypeOf("function");
    }finally{h.close();}
  });
  it("uses native variable stores with casts/indexes and REPLACE_GETVAR avoiding a second macro pass",async()=>{
    const h=await createSlashFixture();try{
      const run=(text:string)=>h.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false});
      expect((await run('/setvar key=x 11 | /addvar key=x 2 | /getvar x')).pipe).toBe("13");
      expect((await run('/setglobalvar key=list [1,2] | /setglobalvar key=list index=1 as=number 9 | /getglobalvar index=1 list')).pipe).toBe("9");
      expect(h.context.chatMetadata.variables.x).toBe(13);expect(h.settings.variables.global).toEqual({list:"[1,9]"});
      expect((await run('/parser-flag REPLACE_GETVAR | /setvar key=literal \\{\\{lastMessageId}} | /pass {{getvar::literal}}')).pipe).toBe("{{lastMessageId}}");
      expect(h.traces.filter(item=>item[0]==="localSave").length).toBeGreaterThan(0);
      expect(h.traces.filter(item=>item[0]==="globalSave").length).toBeGreaterThan(0);
    }finally{h.close();}
  });
  it("executes nested closures, named closure arguments, immediate closures and isolated scoped variables",async()=>{
    const h=await createSlashFixture();try{
      const run=(text:string)=>h.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false});
      expect((await run('/let key=greet {: who=World /pass Hello {{var::who}} :} | /run who=Reader greet')).pipe).toBe("Hello Reader");
      expect((await run('/let key=outer outside | /run {: /let key=outer inside | /pass {{var::outer}} :} | /pass {{var::outer}}/{{pipe}}')).pipe).toBe("outside/inside");
      expect((await run('/pass {: /pass nested :}()')).pipe).toBe("nested");
      expect(h.context.chatMetadata.variables).toEqual({});
      h.power_user.experimental_macro_engine=true;
      expect((await run('/let key=list ["a","b"] | /pass {{var::list::1}}')).pipe).toBe("b");
      expect((await run('/pass {{var::missing}}')).pipe).toBe("");
    }finally{h.close();}
  });
  it("executes if/while/times/math and upstream break/guard semantics",async()=>{
    const h=await createSlashFixture();try{
      const run=(text:string)=>h.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false});
      expect((await run('/if left=3 right=2 rule=gt {: /pass yes :}')).pipe).toBe("yes");
      expect((await run('/let key=n 0 | /while left=n right=3 rule=lt {: /addvar key=count 1 | /var key=n {{pipe}} :} | /var n')).pipe).toBe("3");
      expect((await run('/times 5 {: /pass {{timesIndex}} :}')).pipe).toBe("4");
      expect((await run('/run {: /pass before | /break stopped | /pass after :}')).pipe).toBe("stopped");
      expect((await run('/add 2 3 | /mul {{pipe}} 4')).pipe).toBe("20");
      expect((await run('/setvar key=counter 0 | /times 105 {: /incvar counter :} | /getvar counter')).pipe).toBe("100");
      expect((await run('/setvar key=counter 0 | /times guard=off 105 {: /incvar counter :} | /getvar counter')).pipe).toBe("105");
    }finally{h.close();}
  });
  it("preserves descriptor options and actual scope/controller metadata in awaited callbacks",async()=>{
    const h=await createSlashFixture();try{
      const {api}=h,trace:any[]=[];
      api.registerCommand({name:"async-command-with-a-name-longer-than-thirty-two",aliases:["asyncAlias"],splitUnnamedArgument:true,splitUnnamedArgumentCount:2,
        namedArgumentList:[api.SlashCommandNamedArgument.fromProps({name:"state",aliasList:["s"],defaultValue:"on"}),
          api.SlashCommandNamedArgument.fromProps({name:"item",acceptsMultiple:true})],
        callback:async(args:any,values:any[])=>{await Promise.resolve();trace.push({state:args.state,alias:args.s,items:args.item,values,
          scope:args._scope instanceof api.SlashCommandScope,controller:args._abortController instanceof api.SlashCommandAbortController,
          has:args._hasUnnamedArgument});return values.join("/");}});
      expect((await api.executeSlashCommandsWithOptions('/asyncAlias s=off item=a item=b "one two" three four')).pipe).toBe("one two/ three four");
      expect(trace).toEqual([{state:undefined,alias:"off",items:["a","b"],values:["one two"," three four"],scope:true,controller:true,has:true}]);
      expect((await api.executeSlashCommandsWithOptions('/asyncAlias one')).pipe).toBe("one");expect(trace[1].state).toBeUndefined();
      expect(api.registeredCommand("asyncAlias").namedArgumentList[0]).toMatchObject({defaultValue:"on",aliasList:["s"]});
    }finally{h.close();}
  });
  it("returns upstream abort metadata and fails real missing callbacks/Quick Reply/parser errors",async()=>{
    const h=await createSlashFixture();try{
      const {api}=h;
      const aborted=await api.executeSlashCommandsWithOptions('/abort quiet=true reason | /setvar key=after no');
      expect(aborted).toMatchObject({isAborted:true,isQuietlyAborted:true,abortReason:"reason"});expect(h.context.chatMetadata.variables.after).toBeUndefined();
      const failed=await api.executeSlashCommandsWithOptions('/run missing-quick-reply',{handleExecutionErrors:true});
      expect(failed.isError).toBe(true);expect(failed.errorMessage).toContain("Quick Reply extension is not loaded");
      await expect(api.executeSlashCommandsWithOptions('/missing-command',{handleParserErrors:false})).rejects.toThrow();
      api.SlashCommandParser.addCommandObject(api.SlashCommand.fromProps({name:"fails",callback:()=>{throw new Error("callback failure");}}));
      expect(await api.executeSlashCommandsWithOptions('/fails',{handleExecutionErrors:true})).toMatchObject({isError:true,errorMessage:"callback failure"});
    }finally{h.close();}
  });
  it.each(["controller","stop","story","branch","pagehide"])("cancels delayed pipelines and clears timers/listeners on %s",async trigger=>{
    const h=await createSlashFixture();try{
      const controller=new h.api.SlashCommandAbortController();
      const pending=h.api.executeSlashCommandsWithOptions('/delay 60000 | /setvar key=after no',{abortController:controller});
      await new Promise(resolve=>setTimeout(resolve,5));expect(h.timers.size).toBe(1);
      if(trigger==="controller")controller.abort("caller stopped",true);
      if(trigger==="stop")await h.api.eventSource.emit(h.api.event_types.GENERATION_STOPPED);
      if(trigger==="story")await h.api.applyHostContext({conversationId:"story-b"});
      if(trigger==="branch")await h.api.applyHostContext({branchId:"branch-b"});
      if(trigger==="pagehide")h.pagehide();
      expect(await pending).toMatchObject({isAborted:true});expect(h.timers.size).toBe(0);
      expect(controller.listeners.abort??[]).toHaveLength(0);expect(h.context.chatMetadata.variables.after).toBeUndefined();
    }finally{h.close();}
  });
  it("pauses without polling timers, resumes, and aborts a paused closure with listener cleanup",async()=>{
    const h=await createSlashFixture();try{
      const controller=new h.api.SlashCommandAbortController();controller.pause();
      const paused=h.api.executeSlashCommandsWithOptions('/pass resumed',{abortController:controller});
      await new Promise(resolve=>setTimeout(resolve,5));expect(h.timers.size).toBe(0);controller.continue();expect((await paused).pipe).toBe("resumed");
      controller.pause();const stopped=h.api.executeSlashCommandsWithOptions('/pass nope',{abortController:controller});
      await new Promise(resolve=>setTimeout(resolve,5));controller.abort("paused cancellation",true);
      expect(await stopped).toMatchObject({isAborted:true});expect(controller.listeners.abort??[]).toHaveLength(0);expect(controller.listeners.continue??[]).toHaveLength(0);
    }finally{h.close();}
  });
  it("allows only the next exactly accepted generation branch while independent navigation still aborts",async()=>{
    const h=await createSlashFixture();try{
      const controller=new h.api.SlashCommandAbortController();
      const pending=h.api.executeSlashCommandsWithOptions('/delay 60000 | /setvar key=after no',{abortController:controller});
      await new Promise(resolve=>setTimeout(resolve,5));
      h.acceptGenerationBranch({conversationId:'story-a',branchId:'generation-branch'});
      await h.api.applyHostContext({branchId:'generation-branch'});expect(controller.signal.aborted).toBe(false);expect(h.timers.size).toBe(1);
      await h.api.applyHostContext({branchId:'user-selected-branch'});expect(await pending).toMatchObject({isAborted:true});expect(h.timers.size).toBe(0);
      const other=new h.api.SlashCommandAbortController(),stopped=h.api.executeSlashCommandsWithOptions('/delay 60000',{abortController:other});
      await new Promise(resolve=>setTimeout(resolve,5));h.acceptGenerationBranch({conversationId:'wrong-story',branchId:'generation-branch'});
      await h.api.applyHostContext({branchId:'generation-branch'});expect(await stopped).toMatchObject({isAborted:true});
    }finally{h.close();}
  });
});

it.skipIf(!process.env.SILLYTAVERN_SLASH_ORACLE_ROOT)("compares text and regex command descriptors/callbacks against untouched fixed declarations",async()=>{
  const root=resolve(process.env.SILLYTAVERN_SLASH_ORACLE_ROOT!),source=readFileSync(resolve(root,"public/scripts/slash-commands.js"),"utf8"),utils=readFileSync(resolve(root,"public/scripts/utils.js"),"utf8");
  const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
  const product=await createSlashFixture(),original=await createSlashFixture(root),rows:any[]=[];
  const commands=["/upper Abc","/to-lower MIXED","/substr start=-3 end=-1 morning","/replace pattern=blue replacer=red Blueblue",
    '/replace mode=regex pattern="/blue/gi" replacer=red Blue house blue car','/match pattern="/x([0-9])/g" x1x2',
    '/match pattern="/none/g" x1','/match pattern=none x1','/test pattern="/foo/gg" foo','/test pattern="/foo/gg" /foo/gg',
    '/test pattern="/BLUE/i" blue','/test pattern="/[ /" text','/replace mode=unknown pattern=foo foo'];
  try{
    for(const text of commands){
      const projection=(result:any)=>({pipe:result.pipe,isError:result.isError,errorMessage:result.errorMessage,isAborted:result.isAborted});
      const a=projection(await original.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false,handleExecutionErrors:true}));
      const b=projection(await product.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false,handleExecutionErrors:true}));
      expect(b,text).toEqual(a);rows.push({text,original:a,product:b});
    }
    for(const name of ["upper","lower","substr","replace","test","match"]){
      const a=original.api.SlashCommandParser.commands[name],b=product.api.SlashCommandParser.commands[name];
      expect(a,`original descriptor ${name}`).toBeTruthy();expect(b,`product descriptor ${name}`).toBeTruthy();
      expect(b.aliases).toEqual(a.aliases);expect(b.namedArgumentList.map((item:any)=>({name:item.name,types:item.typeList,default:item.defaultValue})))
        .toEqual(a.namedArgumentList.map((item:any)=>({name:item.name,types:item.typeList,default:item.defaultValue})));
    }
    const report=process.env.MYCOMPANION_SLASH_TEXT_ORACLE_REPORT;
    if(report)writeFileSync(resolve(report),JSON.stringify({passed:true,commit:"7e8663cd9c184a550b37238218bdd32c6efc68e9",slashSourceSha256:sha(source),utilsSourceSha256:sha(utils),rows},null,2));
  }finally{product.close();original.close();}
});

const oracleRoot=process.env.SILLYTAVERN_SLASH_ORACLE_ROOT;
describe.skipIf(!oracleRoot)("fixed-pristine SillyTavern 1.19.0 slash oracle",()=>{
  it("compares genuine upstream parsing/execution with the adapted served graph in both macro modes",async()=>{
    const cases=[
      '/echo hello',
      '/setvar key=x 7 | /getvar key=x',
      '/pass Hello World | /pass {{pipe}}',
      '/pass left\\|right | /pass {{pipe}}',
      '/parser-flag STRICT_ESCAPING | /pass left\\|right',
      '/# comments | /pass A | /pass {{pipe}} B',
      '// comments | /pass done',
      '/pass "spaces and \\"quotes\\""',
      '/let key=greeting Hello | /pass {{var::greeting}}',
      '/let key=list ["item1","item2","item3"] | /pass {{var::list::1}}',
      '/let key=greet {: who=World /pass Hello {{var::who}} :} | /run who=Reader greet',
      '/let key=outer outside | /run {: /let key=outer inside | /pass {{var::outer}} :} | /pass {{var::outer}}/{{pipe}}',
      '/pass {: /pass nested :}()',
      '/run {: /pass before | /break stopped | /pass after :}',
      '/if left=3 right=2 rule=gt {: /pass yes :}',
      '/let key=n 0 | /while left=n right=3 rule=lt {: /addvar key=count 1 | /var key=n {{pipe}} :} | /var n',
      '/times 5 {: /pass {{timesIndex}} :}',
      '/setvar key=counter 0 | /times 105 {: /incvar counter :} | /getvar counter',
      '/setvar key=counter 0 | /times guard=off 105 {: /incvar counter :} | /getvar counter',
      '/add 2 3 | /mul {{pipe}} 4',
      '/setvar key=x 11 | /addvar key=x 2 | /getvar x',
      '/setglobalvar key=list [1,2] | /setglobalvar key=list index=1 as=number 9 | /getglobalvar index=1 list',
      '/parser-flag REPLACE_GETVAR | /setvar key=literal \\{\\{lastMessageId}} | /pass {{getvar::literal}}',
      '/delay 1 | /pass delayed',
      '/abort quiet=true reason | /setvar key=after no',
      '/run missing-quick-reply',
      '/missing-command',
      '/let key=x 1 | /let key=x 2',
      '/run {: /var missing :}',
      '/pass {: /pass unfinished',
      '/pass "unclosed',
    ];
    const records:any[]=[];
    for(const experimental of [false,true])for(const text of cases){
      const original=await createSlashFixture(oracleRoot!),adapted=await createSlashFixture();
      try{
        original.power_user.experimental_macro_engine=adapted.power_user.experimental_macro_engine=experimental;
        const run=async(h:any)=>{try{return {result:JSON.parse(JSON.stringify(await h.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false,handleExecutionErrors:false}))),
          local:h.context.chatMetadata.variables,global:h.settings.variables.global};}catch(error:any){return {error:{name:error.name,message:error.message,line:error.line,column:error.column},local:h.context.chatMetadata.variables,global:h.settings.variables.global};}};
        const expected=await run(original),actual=await run(adapted);
        records.push({experimental,text,expected,actual});expect(actual,`${experimental?'experimental':'legacy'} ${text}`).toEqual(expected);
      }finally{original.close();adapted.close();}
    }
    const paths=['scripts/slash-commands/SlashCommandParser.js','scripts/slash-commands/SlashCommandClosure.js','scripts/slash-commands/SlashCommandScope.js','scripts/slash-commands.js','scripts/variables.js','scripts/autocomplete/EnhancedMacroAutoCompleteOption.js'];
    const sourceHashes=paths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(resolve(oracleRoot!,"public",path))).digest('hex')}));
    const beforePath=process.env.MYCOMPANION_SLASH_BEFORE_PATH,beforeRecords:any[]=[];
    let beforeSha256;
    if(beforePath){
      const previous=readFileSync(resolve(beforePath),"utf8");beforeSha256=createHash('sha256').update(previous).digest('hex');
      const ast:any=parseJavaScript(previous,{ecmaVersion:"latest",sourceType:"module"});
      const declaration=ast.body.find((node:any)=>node.declaration?.declarations?.[0]?.id?.name==="slashRuntimeSource").declaration;
      const beforeSource=runInNewContext(previous.slice(declaration.start,declaration.end)+"\nslashRuntimeSource");
      for(const text of cases){const h=await createSlashFixture(undefined,beforeSource);try{
        const result=JSON.parse(JSON.stringify(await h.api.executeSlashCommandsWithOptions(text,{handleParserErrors:false,handleExecutionErrors:true}).catch((error:any)=>({error:error.message}))));
        beforeRecords.push({text,result,local:h.context.chatMetadata.variables,global:h.settings.variables.global});
      }finally{h.close();}}
    }
    writeFileSync(resolve('.cache/reports/e01-upstream-slash-oracle-20261003.json'),JSON.stringify({commit:'7e8663cd9c184a550b37238218bdd32c6efc68e9',sourceHashes,records,beforeSha256,beforeRecords},null,2));
    expect(records).toHaveLength(62);
  },30000);
});

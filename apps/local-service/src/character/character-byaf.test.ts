import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { parseCharacterByaf } from "./character-byaf.js";
import { defaultByafPortrait } from "./character-byaf-utils.js";
import { parseCharacterArchive } from "./character-archive.js";

const date="2025-06-13T12:00:00.000Z";
function inputs(){
  const manifest={schemaVersion:1,createdAt:date,characters:["characters/cartographer/character.json"],
    scenarios:["scenarios/first.json","scenarios/second.json"],author:{name:"Project fixture",backyardURL:"https://example.com/author"},unknownManifest:{kept:true}};
  const character={schemaVersion:1,id:"fixture-character",name:"Cartographer",displayName:"The Cartographer",isNSFW:false,
    persona:"{character} remembers {user}",createdAt:date,updatedAt:date,loreItems:[{key:"harbor,port",value:"A safe harbor"}],
    images:[{path:"images/main.png",label:"main"},{path:"images/alternative.jpeg",label:"alternative"}],unknownCharacter:{kept:true}};
  const scenario=(title:string)=>({schemaVersion:1,title,formattingInstructions:"Answer as {character}",minP:0.1,minPEnabled:true,
    temperature:0.7,repeatPenalty:1.1,repeatLastN:64,topK:40,topP:0.9,exampleMessages:[{characterID:"fixture-character",text:"#{character}: example"}],
    canDeleteExampleMessages:true,firstMessages:[{characterID:"fixture-character",text:title+" greeting"}],narrative:title+" narrative",
    promptTemplate:"ChatML",grammar:null,backgroundImage:"backgrounds/harbor.png",unknownScenario:{kept:true},messages:[
      {type:"human",createdAt:date,updatedAt:date,text:"Where?",unknownMessage:{kept:true}},
      {type:"ai",unknownMessage:{kept:true},outputs:[{createdAt:date,updatedAt:date,activeTimestamp:date,text:"Old harbor"},
        {createdAt:date,updatedAt:date,activeTimestamp:"2025-06-13T12:01:00.000Z",text:"New harbor"}]}]});
  return {manifest,character,scenarios:[scenario("First"),scenario("Second")]};
}
async function zip(input=inputs(), overrides: Map<string,Buffer>=new Map()){
  const files=new Map<string,Buffer>([["manifest.json",Buffer.from(JSON.stringify(input.manifest))],
    [input.manifest.characters[0]!,Buffer.from(JSON.stringify(input.character))],
    ...["scenarios/first.json","scenarios/second.json"].map((path,index)=>[path,Buffer.from(JSON.stringify(input.scenarios[index]))] as [string,Buffer]),
    ["characters/cartographer/images/main.png",defaultByafPortrait],
    ["characters/cartographer/images/alternative.jpeg",Buffer.from([255,216,255,217])],
    ["backgrounds/harbor.png",defaultByafPortrait],["extra/script.js",Buffer.from("throw new Error('not executed')")]]);
  overrides.forEach((bytes,path)=>files.set(path,bytes));
  const archive=new ZipFile(),parts:Buffer[]=[];
  const done=new Promise<Buffer>((resolve,reject)=>{archive.outputStream.on("data",chunk=>parts.push(chunk));archive.outputStream.on("error",reject);archive.outputStream.on("end",()=>resolve(Buffer.concat(parts)));});
  files.forEach((bytes,path)=>archive.addBuffer(bytes,path));archive.end();return done;
}
async function commit(app:ReturnType<typeof buildApp>,bytes:Buffer,key="byaf-original",query=""){
  return app.inject({method:"POST",url:"/api/characters/import/commit"+query,headers:{"content-type":"application/byaf","idempotency-key":key},payload:bytes});
}

describe("BYAF real archive/card/story transaction",()=>{
  it("previews without writes, imports card and every scenario/swipe/asset, and replays without duplicate stories",async()=>{
    const app=buildApp(),bytes=await zip();
    try{
      const preview=await app.inject({method:"POST",url:"/api/characters/import/preview",headers:{"content-type":"application/charx"},payload:bytes});
      expect(preview.statusCode,preview.body).toBe(200);expect(preview.json()).toMatchObject({format:"backyard-byaf",importedScenarioCount:2,importedAssetCount:8});
      expect((await app.inject({method:"GET",url:"/api/characters"})).json().total).toBe(0);
      expect((await app.inject({method:"GET",url:"/api/conversations"})).json().total).toBe(0);
      const imported=await commit(app,bytes);expect(imported.statusCode,imported.body).toBe(201);const id=imported.json().id;
      expect(imported.json()).toMatchObject({sourceFormat:"backyard-byaf",description:"{{char}} remembers {{user}}",scenario:"First narrative",alternateGreetings:["Second greeting"]});
      const stories=(await app.inject({method:"GET",url:"/api/conversations"})).json();expect(stories.total).toBe(2);
      for(const item of stories.items){
        const story=(await app.inject({method:"GET",url:`/api/conversations/${item.id}`})).json();
        expect(story.messages.map((message:{content:string})=>message.content)).toEqual([item.title+" greeting","Where?","New harbor"]);
        expect(story.messages[2].extensionData).toMatchObject({swipes:["Old harbor","New harbor"],swipe_id:1});
        expect(story.messages[1].extensionData.byaf_source_message).toMatchObject({unknownMessage:{kept:true}});
        expect(story.messages[2].extensionData.byaf_source_message).toMatchObject({unknownMessage:{kept:true},outputs:[{text:"Old harbor"},{text:"New harbor"}]});
        expect(story.messages.every((message:{createdAt:string})=>message.createdAt===date)).toBe(true);
        expect(story.chatMetadata).toMatchObject({tainted:true,scenario:item.title+" narrative",system_prompt:"Answer as {{char}}",byaf_import:{scenario:{unknownScenario:{kept:true}}}});
        expect(story.chatMetadata.custom_background).toContain(`/api/characters/${id}/assets/backgrounds/harbor.png`);
      }
      expect((await app.inject({method:"GET",url:`/api/characters/${id}/assets/extra/script.js`})).rawPayload).toEqual(Buffer.from("throw new Error('not executed')"));
      const replay=await commit(app,bytes);expect(replay.statusCode).toBe(200);expect(replay.json().id).toBe(id);
      expect((await app.inject({method:"GET",url:"/api/conversations"})).json().total).toBe(2);
    }finally{await app.close();}
  });
  it("preserves original unknown JSON and every asset through CHARX and full backup restore",async()=>{
    const source=buildApp(),target=buildApp();
    try{
      const imported=await commit(source,await zip()),id=imported.json().id;expect(imported.statusCode,imported.body).toBe(201);
      const exported=await source.inject({method:"GET",url:`/api/characters/${id}/export?format=charx`});expect(exported.statusCode,exported.body).toBe(200);
      const parsed=await parseCharacterArchive(exported.rawPayload);expect(parsed.assets?.get("manifest.json")).toEqual(Buffer.from(JSON.stringify(inputs().manifest)));
      expect(parsed.card.data.extensions.byaf_import).toMatchObject({manifest:{unknownManifest:{kept:true}},character:{unknownCharacter:{kept:true}}});
      const backup=(await source.inject({method:"GET",url:"/api/backup"})).json();
      expect((await target.inject({method:"POST",url:"/api/backup/restore",payload:{backup,strategy:"overwrite"}})).statusCode).toBe(200);
      expect((await target.inject({method:"GET",url:"/api/backup"})).json().conversations).toEqual(backup.conversations);
      expect((await target.inject({method:"GET",url:`/api/characters/${id}`})).json().sourceFormat).toBe("backyard-byaf");
    }finally{await source.close();await target.close();}
  });
  it.each(["copy","replace"])("rolls back the entire HTTP %s import when the second scenario fails, then retries exactly once",async mode=>{
    const directory=await mkdtemp(join(tmpdir(),"mycompanion-byaf-")),path=join(directory,"data.sqlite"),app=buildApp({databasePath:path}),database=new DatabaseSync(path);
    try{
      let query="";
      if(mode==="replace"){
        const old=await app.inject({method:"POST",url:"/api/characters/import/commit",payload:{filename:"old.json",card:{name:"Old",first_mes:"original"}}});expect(old.statusCode).toBe(201);
        const detail=old.json();query=`?mode=replace&targetId=${detail.id}&expectedUpdatedAt=${encodeURIComponent(detail.updatedAt)}`;
        expect((await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:detail.id}})).statusCode).toBe(201);
      }
      const before=(await app.inject({method:"GET",url:"/api/backup"})).json();
      database.exec("CREATE TRIGGER fail_second_scenario BEFORE INSERT ON conversations WHEN NEW.title='Second' BEGIN SELECT RAISE(ABORT,'scenario failure'); END");
      const bytes=await zip(),failed=await commit(app,bytes,"failed-then-retry",query);expect(failed.statusCode,failed.body).toBe(500);
      const after=(await app.inject({method:"GET",url:"/api/backup"})).json();
      for(const field of ["characters","conversations","memories","stageSummaries"]) expect(after[field]).toEqual(before[field]);
      expect(database.prepare("SELECT COUNT(*) n FROM character_import_idempotency WHERE idempotency_key='failed-then-retry'").get()?.n).toBe(0);
      database.exec("DROP TRIGGER fail_second_scenario");expect((await commit(app,bytes,"failed-then-retry",query)).statusCode).toBe(201);
      expect((await commit(app,bytes,"failed-then-retry",query)).statusCode).toBe(200);
      expect((await app.inject({method:"GET",url:"/api/conversations"})).json().total).toBe(mode==="copy"?2:3);
    }finally{await app.close();database.close();await rm(directory,{recursive:true,force:true});}
  });
  it("handles AI-only histories, active outputs and legacy numeric dates without losing timestamps",async()=>{
    const data=inputs();data.scenarios[0]!.messages=[{type:"ai",outputs:[{createdAt:date,updatedAt:date,activeTimestamp:date,text:"Alone"}]}] as typeof data.scenarios[0]["messages"];
    const parsed=await parseCharacterByaf(await zip(data));expect(parsed.byafScenarios[0]!.chat[1]!.send_date).toBe(date);expect(parsed.byafScenarios[0]!.chat[2]!.mes).toBe("Alone");
    (data.scenarios[0]!.messages[0] as any).outputs[0].createdAt=String(Date.parse(date));
    const numeric=await parseCharacterByaf(await zip(data));expect(numeric.byafScenarios[0]!.chat[2]!.send_date).toBe(date);
  });
  it.each(["missing-image","missing-scenario","multiple-characters","empty-outputs","unsafe-image","invalid-date","duplicate-scenario"])("rejects %s before any write",async kind=>{
    const data=inputs();
    if(kind==="missing-image")data.character.images[0]!.path="images/missing.png";
    if(kind==="missing-scenario")data.manifest.scenarios[0]="scenarios/missing.json";
    if(kind==="multiple-characters")data.manifest.characters.push("characters/other/character.json");
    if(kind==="empty-outputs")(data.scenarios[0]!.messages[1] as any).outputs=[];
    if(kind==="unsafe-image")data.character.images[0]!.path="../private.png";
    if(kind==="invalid-date")(data.scenarios[0]!.messages[0] as any).createdAt="invalid";
    if(kind==="duplicate-scenario")data.manifest.scenarios[1]=data.manifest.scenarios[0]!;
    const app=buildApp();try{
      const result=await commit(app,await zip(data));expect(result.statusCode,result.body).toBe(422);
      expect((await app.inject({method:"GET",url:"/api/characters"})).json().total).toBe(0);
      expect((await app.inject({method:"GET",url:"/api/conversations"})).json().total).toBe(0);
    }finally{await app.close();}
  });
});

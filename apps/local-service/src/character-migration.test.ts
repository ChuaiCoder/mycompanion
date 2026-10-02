import {expect,it} from "vitest";
import {buildApp} from "./app.js";
import {apps} from "./test-helpers.js";

it.each([
  {filename:"v1.json",card:{name:"V1",description:"description",first_mes:"greeting",unknown:{kept:true}},format:"tavern-v1-json"},
  {filename:"pygmalion.json",card:{char_name:"Pygmalion",char_persona:"description",char_greeting:"greeting",unknown:{kept:true}},format:"pygmalion-json"},
  {filename:"old.yaml",card:"name: YAML\ncontext: description\ngreeting: greeting\nunknown:\n  kept: true\n",format:"tavern-yaml"},
])("previews, imports, chats, duplicates and backs up $format through the real API",async({filename,card,format})=>{
  const app=buildApp();apps.push(app); const payload={filename,card};
  const preview=await app.inject({method:"POST",url:"/api/characters/import/preview",payload});expect(preview.statusCode,preview.body).toBe(200);
  expect(preview.json().format).toBe(format);expect(preview.json().warningCodes).toContain("legacy_format_converted");
  expect((await app.inject({method:"GET",url:"/api/characters"})).json().total).toBe(0);
  const commit=await app.inject({method:"POST",url:"/api/characters/import/commit",payload,headers:{"idempotency-key":format}});expect(commit.statusCode,commit.body).toBe(201);
  const id=commit.json().id;expect(commit.json().sourceFormat).toBe(format);
  const duplicate=await app.inject({method:"POST",url:"/api/characters/import/preview",payload});expect(duplicate.json().duplicates[0]).toMatchObject({id,match:"exact"});
  const exported=(await app.inject({method:"GET",url:`/api/characters/${id}/export?format=json`})).json();expect(exported).toMatchObject({unknown:{kept:true},data:{description:"description",first_mes:"greeting"}});
  const story=await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:id}});expect(story.statusCode,story.body).toBe(201);expect(story.json().messages[0].content).toBe("greeting");
  const backup=(await app.inject({method:"GET",url:"/api/backup"})).json(),target=buildApp();apps.push(target);
  expect((await target.inject({method:"POST",url:"/api/backup/restore",payload:{backup,strategy:"overwrite"}})).statusCode).toBe(200);
  expect((await target.inject({method:"GET",url:`/api/characters/${id}`})).json().sourceFormat).toBe(format);
});

it.each(["name: [broken","name: Test\nname: Duplicate","- no\n- card","name: Test\na: &a [hello,hello]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]"])("rejects invalid YAML before creating a character",async card=>{
  const app=buildApp();apps.push(app);const response=await app.inject({method:"POST",url:"/api/characters/import/commit",payload:{filename:"broken.yaml",card}});
  expect(response.statusCode,response.body).toBe(422);expect((await app.inject({method:"GET",url:"/api/characters"})).json().total).toBe(0);
});

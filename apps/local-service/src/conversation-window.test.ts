import { expect,it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { buildApp } from "./app.js";
import { RuntimeRepository } from "./persistence/runtime-repository.js";
import { createTestCharacter } from "./testing/native-character.js";

it("reads only the current branch's latest requested window in stable insertion order while keeping complete history available",async()=>{
  const prefix=join(tmpdir(),"mycompanion-window-"),folder=mkdtempSync(prefix),databasePath=join(folder,"runtime.sqlite");
  const app=buildApp({databasePath}),db=new DatabaseSync(databasePath),runtime=new RuntimeRepository(db);
  try {
  const character=await createTestCharacter(app,{ch_name:"Window fixture",first_mes:"Opening"});
  const created=(await app.inject({method:"POST",url:"/api/conversations",payload:{characterId:character.id}})).json();
  for(let index=0;index<130;index++)runtime.addMessage(created.id,index%2?"assistant":"user",`ordered-${index}`);
  const recent=(await app.inject({method:"GET",url:`/api/conversations/${created.id}?messageLimit=100`})).json();
  expect(recent.messageCount).toBe(131);expect(recent.messages).toHaveLength(100);
  expect(recent.messages[0].content).toBe("ordered-30");expect(recent.messages.at(-1).content).toBe("ordered-129");
  const full=runtime.getConversation(created.id)!;
  const fork=runtime.editMessage(created.id,full.messages[119]!.id,"new branch tail")!;
  const branched=(await app.inject({method:"GET",url:`/api/conversations/${created.id}?messageLimit=2`})).json();
  expect(branched.activeBranchId).toBe(fork.branchId);expect(branched.messageCount).toBe(120);
  expect(branched.messages.map((item:{content:string})=>item.content)).toEqual(["ordered-117","new branch tail"]);
  expect((await app.inject({method:"GET",url:`/api/conversations/${created.id}`})).json().messages).toHaveLength(120);
  for(const query of ["0","-1","1.5","1001","bad"])
    expect((await app.inject({method:"GET",url:`/api/conversations/${created.id}?messageLimit=${query}`})).statusCode).toBe(400);
  } finally {await app.close();db.close();if(!resolve(folder).startsWith(resolve(prefix)))throw new Error("Unexpected fixture path");rmSync(folder,{recursive:true,force:true});}
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";
import { encodeCharacterCardPng, parseCharacterCardDocument, parseCharacterCardPngDocument } from "@mycompanion/character-card";
import { buildApp } from "./app.js";
import { parseCharacterArchive, encodeCharacterArchive } from "./character-archive.js";
import { CharacterRepository } from "./character-repository.js";
import { backupChecksum } from "./backup.js";
import { validateCharacterAssetBackup } from "./character-assets.js";
import { apps, fullV2Card } from "./test-helpers.js";

const original = parseCharacterCardDocument(fullV2Card).card;
const image = Buffer.from(encodeCharacterCardPng(original));
const sound = Buffer.from([82,73,70,70,1,2,3,4]);
function card() {
  return { ...structuredClone(original), spec: "chara_card_v3", spec_version: "3.0", customTop: { retained: true },
    data: { ...structuredClone(original.data), customAssetNote: "retained",
      assets: [{ type:"icon", name:"main", ext:"png", uri:"embeded://assets/icon/main.png" },
        { type:"audio",name:"greeting",ext:"wav",uri:"embedded://assets/audio/greeting.wav" }] } };
}
async function archive(entries: Array<[string,Buffer]>, options: { mode?: number } = {}) {
  const zip = new ZipFile(), parts: Buffer[] = [];
  const result = new Promise<Buffer>((resolve,reject) => {
    zip.outputStream.on("data", part => parts.push(part)); zip.outputStream.on("error",reject);
    zip.outputStream.on("end",() => resolve(Buffer.concat(parts)));
  });
  for (const [path,bytes] of entries) zip.addBuffer(bytes,path,{ compress:false,...options });
  zip.end(); return result;
}
const entries = (): Array<[string,Buffer]> => [["card.json",Buffer.from(JSON.stringify(card()))], ["assets/icon/main.png",image],
  ["assets/audio/greeting.wav",sound], ["app-specific.json",Buffer.from('{"custom":"retained"}')], ["assets/code/never-run.js",Buffer.from('throw new Error("must not execute")')]];
const request = async (app: ReturnType<typeof buildApp>, bytes: Buffer, mode = "copy", target?: {id:string;updatedAt:string}) => app.inject({
  method:"POST",url:"/api/characters/import/commit" + (mode === "replace" ? `?mode=replace&targetId=${target!.id}&expectedUpdatedAt=${encodeURIComponent(target!.updatedAt)}` : ""),
  headers:{"content-type":"application/charx","idempotency-key":"original-charx-" + mode},payload:bytes });

describe("CHARX byte-preserving import and export", () => {
  it("retains root card, unknown metadata, image, audio and arbitrary auxiliary bytes", async () => {
    const parsed = await parseCharacterArchive(await archive(entries()));
    expect(parsed.preview.format).toBe("ccv3-charx"); expect(parsed.preview.importedAssetCount).toBe(4);
    expect(parsed.preview.warningCodes).not.toContain("v3_assets_not_imported");
    expect(parsed.card).toMatchObject({customTop:{retained:true},data:{customAssetNote:"retained"}});
    expect(parsed.assets?.get("assets/audio/greeting.wav")).toEqual(sound);
    expect(parsed.sourcePng).toEqual(image);
    const repository = new CharacterRepository();
    try {
      const imported = repository.import(parsed,"archive").character;
      const stored = repository.getStored(imported.id,true)!;
      const reparsed = await parseCharacterArchive(await encodeCharacterArchive(stored));
      expect(reparsed.card).toEqual(parsed.card); expect(reparsed.assets).toEqual(parsed.assets);
    } finally { repository.close(); }
  });
  it("exports CHARX to V3 PNG chunks and imports it back to CHARX/full backup without asset loss", async () => {
    const app=buildApp(), second=buildApp(), restored=buildApp();
    try {
      const imported=await request(app,await archive(entries())); expect(imported.statusCode).toBe(201); const id=imported.json().id;
      const png=await app.inject({method:"GET",url:`/api/characters/${id}/export?format=png`}); expect(png.statusCode,png.body).toBe(200);
      const parsed=parseCharacterCardPngDocument(png.rawPayload);
      expect(parsed.assets).toEqual(new Map(entries().filter(([path])=>path!=="card.json")));
      expect(parsed.card).toMatchObject({customTop:{retained:true},data:{customAssetNote:"retained",assets:[{uri:"__asset:assets/icon/main.png"},{uri:"__asset:assets/audio/greeting.wav"}]}});
      const importedPng=await second.inject({method:"POST",url:"/api/characters/import/commit",headers:{"content-type":"image/png"},payload:png.rawPayload});
      expect(importedPng.statusCode,importedPng.body).toBe(201); expect(importedPng.json().sourceFormat).toBe("ccv3-png");
      const charx=await second.inject({method:"GET",url:`/api/characters/${importedPng.json().id}/export?format=charx`});
      expect((await parseCharacterArchive(charx.rawPayload)).assets).toEqual(parsed.assets);
      const backup=(await second.inject({method:"GET",url:"/api/backup"})).json(); expect(backup.characters[0].sourceFormat).toBe("ccv3-png");
      expect((await restored.inject({method:"POST",url:"/api/backup/restore",payload:{backup,strategy:"overwrite"}})).statusCode).toBe(200);
      expect((await restored.inject({method:"GET",url:`/api/characters/${importedPng.json().id}`})).json().sourceFormat).toBe("ccv3-png");
      expect((await restored.inject({method:"GET",url:`/api/characters/${importedPng.json().id}/assets/assets/audio/greeting.wav`})).rawPayload).toEqual(sound);
    } finally {await app.close();await second.close();await restored.close();}
  });
  it("changes a JPEG CHARX portrait atomically, keeps auxiliary bytes and exports the new PNG portrait", async () => {
    const raw=card(); raw.data.assets[0]={type:"icon",name:"main",ext:"jpeg",uri:"embeded://assets/icon/main.jpeg"};
    const jpeg=Buffer.from([255,216,255,217]), parsed=await parseCharacterArchive(await archive([["card.json",Buffer.from(JSON.stringify(raw))],["assets/icon/main.jpeg",jpeg],["assets/audio/greeting.wav",sound]]));
    const database=new DatabaseSync(":memory:"), repository=new CharacterRepository(database);
    try {
      const detail=repository.import(parsed,"portrait").character, before=repository.getStored(detail.id,true);
      const image=encodeCharacterCardPng({...original,data:{...original.data,name:"new portrait"}});
      database.exec("CREATE TEMP TRIGGER reject_portrait BEFORE INSERT ON character_assets WHEN NEW.path LIKE '%main.png' BEGIN SELECT RAISE(ABORT,'portrait write failed'); END");
      expect(()=>repository.update(detail.id,{...parsed.card,data:{...parsed.card.data,name:"edited"}},{sourcePng:image})).toThrow("portrait write failed");
      expect(repository.getStored(detail.id,true)).toEqual(before);
      database.exec("DROP TRIGGER reject_portrait");
      repository.update(detail.id,{...parsed.card,data:{...parsed.card.data,name:"edited"}},{sourcePng:image});
      const edited=repository.getStored(detail.id,true)!; expect(edited.detail.sourceFormat).toBe("ccv3-charx");
      expect(edited.assets?.get("assets/audio/greeting.wav")).toEqual(sound); expect(edited.assets?.get("assets/icon/main.jpeg")).toEqual(jpeg);
      expect(edited.rawCard.spec).toBe("chara_card_v3");
      if(edited.rawCard.spec==="chara_card_v3") expect(edited.rawCard.data.assets?.[0]).toMatchObject({uri:"embeded://assets/icon/main.png",ext:"png"});
      const again=await parseCharacterArchive(await encodeCharacterArchive(edited)); expect(again.sourcePng).toEqual(Buffer.from(image));
    } finally {database.close();}
  });
  it("accepts a cover-prefixed archive and preserves the spec's misspelled embedded URI", async () => {
    const parsed = await parseCharacterArchive(Buffer.concat([Buffer.from([255,216,255,217]),await archive(entries())]));
    expect(parsed.card.spec).toBe("chara_card_v3");
    if (parsed.card.spec === "chara_card_v3") expect(parsed.card.data.assets?.[0]?.uri).toBe("embeded://assets/icon/main.png");
    expect(parsed.assets?.get("assets/icon/main.png")).toEqual(image);
  });
  it("rejects a missing referenced file and never commits a partial card", async () => {
    const app = buildApp(); apps.push(app);
    const result = await request(app,await archive(entries().filter(([path]) => !path.endsWith("greeting.wav"))));
    expect(result.statusCode).toBe(422); expect((await app.inject({method:"GET",url:"/api/characters"})).json().total).toBe(0);
  });
  it("rejects duplicate paths, symbolic links, missing root card and CRC corruption", async () => {
    await expect(parseCharacterArchive(await archive([...entries(),["assets/audio/greeting.wav",sound]]))).rejects.toThrow("重复路径");
    await expect(parseCharacterArchive(await archive(entries(),{mode:0o120777}))).rejects.toThrow("符号链接");
    await expect(parseCharacterArchive(await archive(entries().filter(([path]) => path!=="card.json")))).rejects.toThrow("card.json");
    const corrupted = await archive(entries()); const at = corrupted.indexOf(sound); expect(at).toBeGreaterThan(0); corrupted[at]=83;
    await expect(parseCharacterArchive(corrupted)).rejects.toThrow("校验失败");
  });
  it("rejects embedded traversal while preserving remote URI without fetching it", async () => {
    const traversal = card(); traversal.data.assets[0]!.uri="embeded://../private.png";
    await expect(parseCharacterArchive(await archive([["card.json",Buffer.from(JSON.stringify(traversal))]]))).rejects.toThrow("路径穿越");
    const remote = card(); remote.data.assets[0]!.uri="https://example.invalid/image.png";
    const parsed = await parseCharacterArchive(await archive([["card.json",Buffer.from(JSON.stringify(remote))],["assets/audio/greeting.wav",sound]]));
    expect(parsed.card.spec).toBe("chara_card_v3");
    if (parsed.card.spec === "chara_card_v3") expect(parsed.card.data.assets?.[0]?.uri).toBe(remote.data.assets[0]!.uri);
    expect(parsed.preview.warningCodes).toContain("v3_assets_not_imported");
  });
  it("serves actual assets, exports the complete archive and includes assets in full backup restore", async () => {
    const app = buildApp(); apps.push(app); const bytes = await archive(entries());
    const imported = await request(app,bytes); expect(imported.statusCode).toBe(201);
    const character = imported.json(); expect(character.sourceFormat).toBe("ccv3-charx");
    expect((await app.inject({method:"GET",url:`/api/characters/${character.id}/assets/assets/audio/greeting.wav`})).rawPayload).toEqual(sound);
    const code = await app.inject({method:"GET",url:`/api/characters/${character.id}/assets/assets/code/never-run.js`});
    expect(code.headers["content-type"]).toBe("application/octet-stream"); expect(code.headers["content-disposition"]).toBe("attachment");
    expect((await app.inject({method:"GET",url:`/characters/${character.avatar}`})).rawPayload).toEqual(image);
    const exported = await app.inject({method:"GET",url:`/api/characters/${character.id}/export?format=charx`});
    expect((await parseCharacterArchive(exported.rawPayload)).assets?.get("assets/audio/greeting.wav")).toEqual(sound);
    const replay = await request(app,bytes); expect(replay.statusCode).toBe(200); expect(replay.json().id).toBe(character.id);
    const backup = (await app.inject({method:"GET",url:"/api/backup"})).json();
    expect(backup.characters[0].assets["assets/audio/greeting.wav"]).toBe(sound.toString("base64"));
    const target = buildApp(); apps.push(target);
    const restore = await target.inject({method:"POST",url:"/api/backup/restore",payload:{backup,strategy:"overwrite"}});
    expect(restore.statusCode,restore.body).toBe(200);
    expect((await target.inject({method:"GET",url:`/api/characters/${character.id}/assets/assets/audio/greeting.wav`})).rawPayload).toEqual(sound);
    const again = (await target.inject({method:"GET",url:"/api/backup"})).json(); expect(again.characters[0].assets).toEqual(backup.characters[0].assets);
  });
  it("rolls back card, all assets and idempotency on an actual second-asset write failure, then retries", async () => {
    const database = new DatabaseSync(":memory:"), repository = new CharacterRepository(database);
    try {
      const parsed = await parseCharacterArchive(await archive(entries()));
      database.exec("CREATE TEMP TRIGGER fail_asset BEFORE INSERT ON character_assets WHEN NEW.path LIKE '%greeting.wav' BEGIN SELECT RAISE(ABORT,'asset failure'); END");
      expect(() => repository.import(parsed,"archive","retry")).toThrow("asset failure");
      expect(repository.list().total).toBe(0);
      expect(database.prepare("SELECT COUNT(*) n FROM character_assets").get()?.n).toBe(0);
      expect(database.prepare("SELECT COUNT(*) n FROM character_import_idempotency").get()?.n).toBe(0);
      database.exec("DROP TRIGGER fail_asset");
      const imported = repository.import(parsed,"archive","retry"); expect(imported.replayed).toBe(false);
      expect(repository.assets.get(imported.character.id,"assets/audio/greeting.wav")).toEqual(sound);
    } finally { database.close(); }
  });
  it("rolls back an asset replacement failure without changing the old card or metadata", async () => {
    const database = new DatabaseSync(":memory:"), repository = new CharacterRepository(database);
    try {
      const parsed = await parseCharacterArchive(await archive(entries()));
      const first = repository.import(parsed,"one").character, before = repository.getStored(first.id,true);
      database.exec("CREATE TEMP TRIGGER fail_asset BEFORE INSERT ON character_assets BEGIN SELECT RAISE(ABORT,'replacement failure'); END");
      const updated = { ...parsed, card: {...parsed.card,data:{...parsed.card.data,name:"changed"}} };
      expect(() => repository.import(updated,"two","replace",{mode:"replace",targetId:first.id,expectedUpdatedAt:first.updatedAt})).toThrow("replacement failure");
      expect(repository.getStored(first.id,true)).toEqual(before);
      database.exec("DROP TRIGGER fail_asset");
      const result = repository.import(updated,"two","replace",{mode:"replace",targetId:first.id,expectedUpdatedAt:first.updatedAt});
      expect(result.character.id).toBe(first.id); expect(result.character.name).toBe("changed");
    } finally { database.close(); }
  });
  it("preserves assets across a real database process restart and deletes them with permanent character deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(),"mycompanion-charx-")); const path=join(directory,"profile.sqlite");
    try {
      const repository = new CharacterRepository(path); const parsed = await parseCharacterArchive(await archive(entries()));
      const character = repository.import(parsed,"archive").character; repository.close();
      const restarted = new CharacterRepository(path);
      try { expect(restarted.assets.get(character.id,"assets/audio/greeting.wav")).toEqual(sound); expect(restarted.permanentDelete(character.id)).toBe(true); }
      finally { restarted.close(); }
      const inspect = new DatabaseSync(path); try { expect(inspect.prepare("SELECT count(*) n FROM character_assets").get()?.n).toBe(0); } finally { inspect.close(); }
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it.each(["new", "overwrite"])("keeps the entire database unchanged after an HTTP %s asset restore failure, then retries", async mode => {
    const directory = await mkdtemp(join(tmpdir(),"mycompanion-charx-restore-")); const path=join(directory,"profile.sqlite");
    const source = buildApp(), target = buildApp({databasePath:path}), database = new DatabaseSync(path);
    try {
      const imported = await request(source,await archive(entries())); expect(imported.statusCode).toBe(201);
      const backup = (await source.inject({method:"GET",url:"/api/backup"})).json();
      if (mode === "overwrite") expect((await target.inject({method:"POST",url:"/api/backup/restore",payload:{backup,strategy:"overwrite"}})).statusCode).toBe(200);
      const before = (await target.inject({method:"GET",url:"/api/backup"})).json();
      (backup.characters[0].rawCard.data as Record<string,unknown>).name="Restored name";
      backup.characters[0].assets["assets/audio/greeting.wav"]=Buffer.from("replacement audio").toString("base64");
      backup.manifest.checksum=backupChecksum(backup);
      database.exec("CREATE TRIGGER fail_asset BEFORE INSERT ON character_assets WHEN NEW.path LIKE '%greeting.wav' BEGIN SELECT RAISE(ABORT,'HTTP asset restore failed'); END");
      const failed = await target.inject({method:"POST",url:"/api/backup/restore",payload:{backup,strategy:"overwrite"}});
      expect(failed.statusCode,failed.body).toBe(500);
      const after = (await target.inject({method:"GET",url:"/api/backup"})).json();
      after.createdAt=before.createdAt; after.manifest.checksum=backupChecksum(after);
      expect(after).toEqual(before);
      expect(after.characters).toEqual(before.characters);
      database.exec("DROP TRIGGER fail_asset");
      const retry=await target.inject({method:"POST",url:"/api/backup/restore",payload:{backup,strategy:"overwrite"}});
      expect(retry.statusCode,retry.body).toBe(200);
      expect((await target.inject({method:"GET",url:`/api/characters/${imported.json().id}/assets/assets/audio/greeting.wav`})).rawPayload).toEqual(Buffer.from("replacement audio"));
    } finally { await source.close(); await target.close(); database.close(); await rm(directory,{recursive:true,force:true}); }
  });
  it("rejects invalid backup asset paths and noncanonical base64 at preview and restore before writing", async () => {
    const source=buildApp(), target=buildApp();
    try {
      await request(source,await archive(entries()));
      const original=(await source.inject({method:"GET",url:"/api/backup"})).json();
      for (const assets of [{"../private.png":"AA=="},{"card.json":"AA=="},{"a.bin":"AB=="},{"a.bin":"AAB="},{"a.bin":"abc"}]) {
        const backup=structuredClone(original); backup.characters[0].assets=assets; backup.manifest.checksum=backupChecksum(backup);
        for(const url of ["/api/backup/restore/preview","/api/backup/restore"]) {
          const response=await target.inject({method:"POST",url,payload:{backup,strategy:"overwrite"}});
          expect(response.statusCode,response.body).toBe(422);
        }
        expect((await target.inject({method:"GET",url:"/api/characters"})).json().total).toBe(0);
      }
      expect(()=>validateCharacterAssetBackup(Object.fromEntries(Array.from({length:4097},(_,n)=>[`${n}.bin`,""])))).toThrow("4096");
      expect(()=>validateCharacterAssetBackup({"a.bin":"A".repeat(Math.ceil(16*1024*1024/3)*4+4)})).toThrow("大小");
    } finally { await source.close(); await target.close(); }
  });
  it("keeps CHARX format and asset bytes through edits, and falls back for unsafe JSON portrait metadata", async () => {
    const repository=new CharacterRepository();
    try {
      const parsed=await parseCharacterArchive(await archive(entries())); const detail=repository.import(parsed,"format").character;
      const updated=repository.update(detail.id,{...parsed.card,data:{...parsed.card.data,name:"edited"}})!;
      expect(updated.detail.sourceFormat).toBe("ccv3-charx"); expect(repository.assets.get(detail.id,"assets/audio/greeting.wav")).toEqual(sound);
    } finally {repository.close();}
    const app=buildApp(); apps.push(app); const unsafe=card(); unsafe.data.assets[0]!.uri="embeded://../private.png";
    const imported=await app.inject({method:"POST",url:"/api/characters/import/commit",payload:{filename:"unsafe.json",card:unsafe}}); expect(imported.statusCode,imported.body).toBe(201);
    expect((await app.inject({method:"GET",url:`/characters/${imported.json().avatar}`})).statusCode).toBe(200);
    const exported=await app.inject({method:"GET",url:`/api/characters/${imported.json().id}/export?format=png`});
    expect(exported.statusCode).toBe(422); expect(exported.json().error.code).toBe("PNG_ASSET_EXPORT_UNSUPPORTED");
    expect((await app.inject({method:"GET",url:`/api/characters/${imported.json().id}/export?format=json`})).json().data.assets[0].uri).toBe("embeded://../private.png");
  });
});

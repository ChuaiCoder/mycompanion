import { describe,expect,it } from "vitest";
import { encodeCharacterCardPng,parseCharacterCardDocument,parseCharacterCardPngDocument } from "@mycompanion/character-card";
import { buildApp } from "./app.js";
import { fullV2Card } from "./test-helpers.js";
import { parseCharacterArchive } from "./character-archive.js";
import { inlineCharacterAssetPath,materializeCharacterInlineAssets } from "./character-inline-assets.js";

const image=Buffer.from(encodeCharacterCardPng(parseCharacterCardDocument(fullV2Card).card));
const uri="data:image/png;base64,"+image.toString("base64"),sound=Buffer.from([82,73,70,70,1,2,3,4]);
const card=()=>({...(fullV2Card as Record<string,unknown>),spec:"chara_card_v3",spec_version:"3.0",data:{...(fullV2Card as any).data,
  assets:[{type:"icon",name:"main",ext:"png",uri},{type:"audio",name:"greeting",ext:"wav",uri:"data:audio/wav;base64,"+sound.toString("base64")}],unknownData:{kept:true}}});

describe("V3 inline data URI assets",()=>{
  it("imports, displays and exports exact inline bytes without changing JSON URIs, and restores the backup",async()=>{
    const source=buildApp(),target=buildApp();
    try{
      const payload={filename:"inline.json",card:card()};
      const preview=await source.inject({method:"POST",url:"/api/characters/import/preview",payload});expect(preview.statusCode,preview.body).toBe(200);
      expect(preview.json().importedAssetCount).toBe(2);expect(preview.json().warningCodes).not.toContain("v3_assets_not_imported");
      const imported=await source.inject({method:"POST",url:"/api/characters/import/commit",payload});expect(imported.statusCode,imported.body).toBe(201);const{id,avatar}=imported.json();
      const thumbnail=await source.inject({method:"GET",url:`/characters/${avatar}`});expect(thumbnail.rawPayload).toEqual(image);expect(thumbnail.headers["content-type"]).toContain("image/png");
      const json=(await source.inject({method:"GET",url:`/api/characters/${id}/export?format=json`})).json();expect(json.data.unknownData).toEqual({kept:true});expect(json.data.assets[0].uri).toBe(uri);
      const charx=await source.inject({method:"GET",url:`/api/characters/${id}/export?format=charx`}),parsed=await parseCharacterArchive(charx.rawPayload);
      expect(parsed.card).toEqual(json);expect(parsed.assets?.get(inlineCharacterAssetPath(uri,"png")!)).toEqual(image);
      expect(parsed.preview.warningCodes).not.toContain("v3_assets_not_imported");
      const png=await source.inject({method:"GET",url:`/api/characters/${id}/export?format=png`});expect(png.statusCode,png.body).toBe(200);const reparsed=parseCharacterCardPngDocument(png.rawPayload);
      if(reparsed.card.spec!=="chara_card_v3")throw new Error("Expected V3 PNG after inline asset export");
      expect(reparsed.card.data.unknownData).toEqual({kept:true});expect(reparsed.card.data.assets?.[0]?.uri).toBe("__asset:"+inlineCharacterAssetPath(uri,"png"));
      expect(reparsed.assets?.get(inlineCharacterAssetPath(uri,"png")!)).toEqual(image);
      const backup=(await source.inject({method:"GET",url:"/api/backup"})).json();expect((await target.inject({method:"POST",url:"/api/backup/restore",payload:{backup,strategy:"overwrite"}})).statusCode).toBe(200);
      expect((await target.inject({method:"GET",url:`/characters/${avatar}`})).rawPayload).toEqual(image);
    }finally{await source.close();await target.close();}
  });
  it("keeps a warning for remote/non-base64 assets and rejects malformed data before committing any row",async()=>{
    const app=buildApp();try{
      const raw=card();raw.data.assets.push({type:"icon",name:"remote",ext:"png",uri:"https://example.com/icon.png"});
      const preview=await app.inject({method:"POST",url:"/api/characters/import/preview",payload:{filename:"mixed.json",card:raw}});
      expect(preview.json().warningCodes).toContain("v3_assets_not_imported");expect(preview.json().importedAssetCount).toBe(2);
      for(const encoded of ["AB==","AAB=","abc","%%%="]){const invalid=card();invalid.data.assets[0]!.uri="data:image/png;base64,"+encoded;
        const failed=await app.inject({method:"POST",url:"/api/characters/import/commit",payload:{filename:"invalid.json",card:invalid}});expect(failed.statusCode,failed.body).toBe(422);}
      expect((await app.inject({method:"GET",url:"/api/characters"})).json().total).toBe(0);
    }finally{await app.close();}
  });
  it("deduplicates identical URI assets and rejects a spoofed existing archive entry or oversized encoded blob",()=>{
    const raw=card();raw.data.assets.push({...raw.data.assets[0]!});const parsed=parseCharacterCardDocument(raw);
    const imported=materializeCharacterInlineAssets(parsed);expect(imported.assets?.size).toBe(2);
    const path=inlineCharacterAssetPath(uri,"png")!;
    expect(("chara-ext-asset_:"+inlineCharacterAssetPath(uri,"abcdefghijkl")!).length).toBeLessThanOrEqual(79);
    expect(()=>materializeCharacterInlineAssets({...parsed,assets:new Map([[path,Buffer.from("spoof")]])})).toThrow("字节不一致");
    const huge=card();huge.data.assets[0]!.uri="data:image/png;base64,"+"A".repeat(Math.ceil(16*1024*1024/3)*4+4);
    expect(()=>materializeCharacterInlineAssets(parseCharacterCardDocument(huge))).toThrow("data URI");
  });
});

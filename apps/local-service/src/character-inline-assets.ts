import { createHash } from "node:crypto";
import { CharacterCardParseError } from "@mycompanion/character-card";
import type { CharacterImport } from "./character-repository.js";
import { characterAssetBase64Size } from "./character-assets.js";

const dataUri = /^data:([^,]*?);base64,([\s\S]*)$/i;
/** Stable local identity; original card URIs stay intact for JSON roundtrips. */
export function inlineCharacterAssetPath(uri: unknown, extension: string): string | null {
  if(typeof uri!=="string"||!dataUri.test(uri))return null;
  const header=dataUri.exec(uri)![1]!.split(";")[0]!.toLowerCase();
  const mimeExtensions:Record<string,string>={"image/png":"png","image/jpeg":"jpeg","image/webp":"webp","image/gif":"gif","audio/wav":"wav","audio/mpeg":"mp3","audio/ogg":"ogg","video/mp4":"mp4"};
  const ext=/^[a-z0-9]{1,12}$/i.test(extension)?extension.toLowerCase():mimeExtensions[header]??"bin";
  // Full SHA-256 in URL-safe base64 keeps even a 12-character extension within
  // PNG's 79-byte asset keyword limit, without truncating the content identity.
  return `data/${createHash("sha256").update(uri).digest("base64url")}.${ext}`;
}
/** V3/Risu JSON data: assets use existing base64/size rules and SQLite transactions. */
export function materializeCharacterInlineAssets(imported: CharacterImport): CharacterImport {
  if(imported.card.spec!=="chara_card_v3")return imported;
  const files=new Map([...imported.assets??[]].map(([path,bytes])=>[path,Buffer.from(bytes)]));
  let total=[...files.values()].reduce((sum,bytes)=>sum+bytes.length,0),processed=false;
  for(const asset of imported.card.data.assets??[]){
    const path=inlineCharacterAssetPath(asset.uri,asset.ext);
    if(!path)continue;
    processed=true;
    const encoded=dataUri.exec(asset.uri)![2]!;
    let size:number;
    try{size=characterAssetBase64Size(encoded);}
    catch(error){throw new CharacterCardParseError("角色卡内嵌 data URI 资产无效。",[error instanceof Error?error.message:String(error)]);}
    const decoded=Buffer.from(encoded,"base64"),previous=files.get(path);
    if(previous){if(!previous.equals(decoded))throw new CharacterCardParseError("角色卡 data URI 与同名附件字节不一致。");continue;}
    if(files.size>=4096||(total+=size)>64*1024*1024)throw new CharacterCardParseError("角色卡内嵌资产总量超出限制。");
    files.set(path,decoded);
  }
  if(!processed)return imported;
  const missing=(imported.card.data.assets??[]).some(asset=>{
    const inline=inlineCharacterAssetPath(asset.uri,asset.ext);
    if(inline)return !files.has(inline);
    // Existing PNG/CHARX readers resolve embedded references; remote and other
    // forms remain explicitly unimported, with the original URI preserved.
    const embedded=/^(?:embeded:\/\/|embedded:\/\/|__asset:)(.*)$/i.exec(asset.uri);
    return embedded?!files.has(embedded[1]!):asset.uri!=="ccdefault:";
  });
  return {...imported,assets:files,preview:{...imported.preview,importedAssetCount:files.size,
    warningCodes:imported.preview.warningCodes.filter(code=>code!=="v3_assets_not_imported"||missing)}};
}

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { CharacterCardParseError, parseCharacterCardDocument } from "@mycompanion/character-card";
import type { CharacterImport } from "./character-repository.js";
import type { RuntimeRepository } from "../persistence/runtime-repository.js";
import { readBoundedZip, normalizeZipPath } from "../bounded-zip.js";
import { characterAssetLimits } from "./character-archive.js";
import { ByafParser } from "../character-byaf-upstream.js";
import { byafManifestSchema, byafCharacterSchema, byafScenarioSchema } from "../character-byaf-schemas.js";
import { byafDate } from "../character-byaf-utils.js";

type JsonObject = Record<string, unknown>;
export interface ByafImport extends CharacterImport {
  byafScenarios: Array<{ path: string; raw: JsonObject; chat: Array<JsonObject> }>;
}
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CharacterCardParseError(`BYAF ${label} 必须是对象。`);
  return value as JsonObject;
}
function json(files: Map<string,Buffer>, path: string): JsonObject {
  const bytes=files.get(normalizeZipPath(path));
  if (!bytes) throw new CharacterCardParseError("BYAF 缺少引用的文件。", [path]);
  try {return object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),path);}
  catch(error) { if(error instanceof CharacterCardParseError) throw error; throw new CharacterCardParseError("BYAF 文件不是有效 UTF-8 JSON。",[path]); }
}
function validate(schema: {safeParse(value:unknown):{success:boolean;error?:{issues:Array<{path:PropertyKey[];message:string}>}}}, value:unknown, label:string): void {
  const result=schema.safeParse(value);
  if (!result.success) throw new CharacterCardParseError(`BYAF ${label} 格式无效。`,result.error!.issues.map(issue=>`${issue.path.map(String).join(".")}: ${issue.message}`));
}

/** Reuse fixed ST conversion and official schemas; preserve original JSON/bytes. */
export async function parseCharacterByaf(bytes: Buffer, inspectedFiles?: Map<string,Buffer>): Promise<ByafImport> {
  const files=inspectedFiles??await readBoundedZip(bytes,characterAssetLimits);
  const manifest=json(files,"manifest.json");
  const normalizedManifest={schemaVersion:1,createdAt:"1970-01-01T00:00:00.000Z",...manifest};
  // Earlier Backyard exports and ST's supported fixture use characters/name.json.
  // Single-character semantics remain the official contract; never silently drop extras.
  const characterPaths=manifest.characters;
  if (!Array.isArray(characterPaths) || characterPaths.length!==1 || typeof characterPaths[0]!=="string")
    throw new CharacterCardParseError("BYAF 必须引用一个角色；多角色归档请拆分后导入。");
  // Official path regex is relaxed only to safe characters/*.json for old exports.
  const characterPath=normalizeZipPath(characterPaths[0]);
  if (!/^characters\/.+\.json$/i.test(characterPath)) throw new CharacterCardParseError("BYAF 角色路径必须位于 characters/。");
  const validationManifest={...normalizedManifest,characters:["characters/import/character.json"]};
  validate(byafManifestSchema,validationManifest,"manifest");
  const character=json(files,characterPath);
  const normalizedCharacter={schemaVersion:1,id:characterPath,name:character.displayName??"",displayName:character.name??"",isNSFW:false,
    persona:"",createdAt:normalizedManifest.createdAt,updatedAt:normalizedManifest.createdAt,loreItems:[],images:[],...character};
  validate(byafCharacterSchema,normalizedCharacter,"character");
  const scenarioPaths=manifest.scenarios as string[];
  if (new Set(scenarioPaths).size!==scenarioPaths.length) throw new CharacterCardParseError("BYAF 包含重复场景引用。");
  const scenarios=scenarioPaths.map(path=>json(files,path));
  const normalizedScenarios=scenarios.map((raw,index)=>{
    const normalized:JsonObject={schemaVersion:1,formattingInstructions:"",minP:0.1,minPEnabled:true,temperature:1.2,repeatPenalty:1.05,
      repeatLastN:256,topK:40,topP:0.9,exampleMessages:[],canDeleteExampleMessages:false,firstMessages:[],narrative:"",promptTemplate:"general",grammar:null,messages:[],...raw};
    for(const key of ["exampleMessages","firstMessages"]) if(Array.isArray(normalized[key]))
      normalized[key]=(normalized[key] as unknown[]).map(item=>({characterID:normalizedCharacter.id,...object(item,key)}));
    // Preserve legacy numeric timestamps in original bytes; normalize only validation.
    if(Array.isArray(normalized.messages)) normalized.messages=normalized.messages.map(item=>{
      const message=object(item,"message");
      if(message.type==="human") return {...message,createdAt:byafDate(message.createdAt),updatedAt:byafDate(message.updatedAt??message.createdAt)};
      return {...message,outputs:Array.isArray(message.outputs)?message.outputs.map(item=>{
        const output=object(item,"output"); return {...output,createdAt:byafDate(output.createdAt),updatedAt:byafDate(output.updatedAt??output.createdAt),activeTimestamp:byafDate(output.activeTimestamp??output.createdAt)};
      }):message.outputs};
    });
    validate(byafScenarioSchema,normalized,scenarioPaths[index]!);
    return normalized;
  });
  const validatedFiles=new Map(files);
  validatedFiles.set("manifest.json",Buffer.from(JSON.stringify({...normalizedManifest,characters:[characterPath]})));
  validatedFiles.set(characterPath,Buffer.from(JSON.stringify(normalizedCharacter)));
  normalizedScenarios.forEach((scenario,index)=>validatedFiles.set(scenarioPaths[index]!,Buffer.from(JSON.stringify(scenario))));
  const images=normalizedCharacter.images as Array<{path:string;label:string}>;
  const imagePaths=images.map(image=>normalizeZipPath(posix.dirname(characterPath)+"/"+normalizeZipPath(image.path)));
  for(const path of imagePaths) if(!files.has(path)) throw new CharacterCardParseError("BYAF 缺少头像附件。",[path]);
  for(const scenario of normalizedScenarios) if(scenario.backgroundImage!==undefined){
    const path=normalizeZipPath(String(scenario.backgroundImage));
    if(!files.has(path)) throw new CharacterCardParseError("BYAF 缺少背景附件。",[path]);
  }
  const converted=await new ByafParser(validatedFiles).parse();
  const rawCard={...converted.card,spec:"chara_card_v3",spec_version:"3.0",create_date:normalizedCharacter.createdAt,
    data:{...converted.card.data,extensions:{...converted.card.data.extensions,byaf_import:{manifest,character,scenarioPaths}},
      assets:imagePaths.map((path,index)=>({type:"icon",name:index===0?"main":images[index]!.label||`portrait-${index}`,ext:posix.extname(path).slice(1),uri:"embeded://"+path}))}};
  const parsed=parseCharacterCardDocument(rawCard);
  const byafScenarios=normalizedScenarios.map((scenario,index)=>{
    const raw=scenarios[index]!,chat=ByafParser.getChatFromScenario(scenario,"User",parsed.card.data.name,converted.chatBackgrounds)
      .split("\n").map((line:string)=>JSON.parse(line) as JsonObject);
    const originals=Array.isArray(raw.messages)?raw.messages.map(item=>object(item,"message")):[];
    const users=originals.filter(message=>message.type==="human"),assistants=originals.filter(message=>message.type==="ai");
    const ordered=users.length===assistants.length?users.flatMap((user,position)=>[user,assistants[position]!]):originals;
    const greetings=Array.isArray(raw.firstMessages)?raw.firstMessages:[];
    const greetingOffset=greetings[0] && object(greetings[0],"greeting").text?1:0;
    if(greetingOffset) chat[1]!.byaf_source_greeting=greetings[0];
    ordered.forEach((message,position)=>{chat[position+1+greetingOffset]!.byaf_source_message=message;});
    return {path:scenarioPaths[index]!,raw,chat};
  });
  const portrait=imagePaths[0]?files.get(imagePaths[0]):undefined;
  return {...parsed,assets:files,...(portrait?.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?{sourcePng:portrait}:{}),byafScenarios,
    preview:{...parsed.preview,format:"backyard-byaf",importedAssetCount:files.size,importedScenarioCount:byafScenarios.length,
      warningCodes:[...parsed.preview.warningCodes.filter(code=>code!=="v3_assets_not_imported"),"legacy_format_converted"]}};
}

/** Called inside the import transaction; a failure rolls back cards, assets and all scenarios. */
export function importByafScenarios(imported: ByafImport, characterId: string, runtime: RuntimeRepository): void {
  for(const scenario of imported.byafScenarios){
    const id=randomUUID(),branchId=randomUUID(),createdAt=byafDate(scenario.raw.createdAt??scenario.chat[1]?.send_date);
    let parentMessageId:string|null=null;
    const messages=scenario.chat.slice(1).map(message=>{
      const messageId=randomUUID(),parent=parentMessageId;parentMessageId=messageId;
      return {id:messageId,branchId,parentMessageId:parent,role:message.is_user?"user" as const:"assistant" as const,
        content:String(message.mes??""),status:"complete" as const,createdAt:byafDate(message.send_date),
        extensionData:{...message}};
    });
    const background=scenario.raw.backgroundImage;
    const backgroundUrl=typeof background==="string"?`/api/characters/${characterId}/assets/${normalizeZipPath(background).split("/").map(encodeURIComponent).join("/")}`:null;
    const metadata=object(scenario.chat[0]?.chat_metadata??{},"chat metadata");
    runtime.restoreConversation({id,characterId,characterName:imported.card.data.name,
      title:typeof scenario.raw.title==="string"?scenario.raw.title:posix.basename(scenario.path,".json"),activeBranchId:branchId,
      createdAt,updatedAt:messages.at(-1)?.createdAt??createdAt,messages,
      chatMetadata:{...metadata,tainted:true,byaf_import:{path:scenario.path,scenario:scenario.raw},
        ...(backgroundUrl?{chat_backgrounds:[backgroundUrl],custom_background:`url("${backgroundUrl}")`}: {})}});
  }
}

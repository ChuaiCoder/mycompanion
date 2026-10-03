import { modelResponseStateSchema, type ProviderSettings } from "@mycompanion/shared";
import { ModelRequestError } from "./model-request-error.js";
import { convertClaudeMessages, convertGooglePrompt, calculateClaudeBudgetTokens, calculateGoogleBudgetTokens } from "./provider-converters-upstream.js";

export type CompletionProtocol = "openai" | "claude" | "gemini";
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

export function providerCompletionSource(kind: ProviderSettings["kind"]): "custom" | "claude" | "makersuite" {
  return kind === "anthropic" ? "claude" : kind === "gemini" ? "makersuite" : "custom";
}
export function completionProtocol(source: unknown): CompletionProtocol {
  if (source === "custom" || source === "openai") return "openai";
  if (source === "claude") return "claude";
  if (source === "makersuite") return "gemini";
  throw new ModelRequestError("尚未实现该提供商的原生传输协议。", 400);
}

function endpoint(baseUrl: string, path: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ModelRequestError("模型地址无效，请在设置中检查 API 地址。", 400); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ModelRequestError("模型地址必须为不含账号或密钥的 HTTP(S) API 地址。", 400);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${path}`; url.search = ""; url.hash = "";
  return url;
}

/** Native reasoning signatures are scoped to the model that produced them.
 * The internal replay marker is removed before any request reaches a provider.
 * Historical tool rounds from legacy databases are not replayed to providers;
 * the canonical assistant text is sent on its own. */
export function replayProviderResponseMessages(messages:unknown,protocol:CompletionProtocol,model:string,preserveOrigin=false):unknown {
  if(!Array.isArray(messages))return messages;
  const expanded=messages.flatMap(raw=>{
    const message=object(raw),rounds=message.toolRounds;if(rounds===undefined)return [raw];
    const canonical={...message};delete canonical.toolRounds;
    return [canonical];
  });
  return expanded.map(raw=>{
    const message=structuredClone(object(raw));
    let originModel=message.provider_response_model,originProtocol=message.provider_response_protocol;
    const carryOrigin=(value:Record<string,any>)=>preserveOrigin&&typeof originModel==="string"&&typeof originProtocol==="string"
      ?{...value,provider_response_model:originModel,provider_response_protocol:originProtocol}:value;
    delete message.provider_response_model;delete message.provider_response_protocol;
    if(originModel!==undefined&&(originModel!==model||originProtocol!==protocol)) {
      delete message.signature;delete message.reasoning_content;delete message.reasoning;
      if(Array.isArray(message.content))message.content=message.content.flatMap((part:Record<string,any>)=>{
        if(part.type==="thinking"||part.type==="redacted_thinking")return [];
        if(part.type==="provider_native"){
          const native=object(part.part);if(native.thought)return [];
          delete native.thoughtSignature;delete native.thought_signature;return [{...part,part:native}];
        }
        return [part];
      });
      if(Array.isArray(message.tool_calls))for(const call of message.tool_calls)delete call.signature;
    }
    const rawState=message.responseState;delete message.responseState;
    if(rawState===undefined||message.role!=="assistant")return carryOrigin(message);
    const parsed=modelResponseStateSchema.safeParse(rawState);
    if(!parsed.success)throw new ModelRequestError("历史回复的原生状态无效。",400);
    const state=parsed.data,sameModel=state.model===model,sameProtocol=state.protocol===protocol;
    originModel=state.model;originProtocol=state.protocol;
    const content=typeof message.content==="string"?message.content:"";
    if(sameProtocol&&protocol==="claude")return carryOrigin({...message,content:[
      ...(sameModel?state.providerContent.filter(part=>part.type==="thinking"||part.type==="redacted_thinking"):[]),{type:"text",text:content},
    ]});
    if(sameProtocol&&protocol==="gemini"){
      const parts=structuredClone(state.providerContent).filter(part=>sameModel||!part.thought);
      if(!sameModel)for(const part of parts){delete part.thoughtSignature;delete part.thought_signature;}
      const original=parts.filter(part=>!part.thought&&typeof part.text==="string").map(part=>part.text).join("");
      if(original!==content){
        let replaced=false;
        for(const part of parts)if(!part.thought&&typeof part.text==="string"){part.text=replaced?"":content;replaced=true;}
        if(!replaced&&content)parts.push({text:content});
      }
      return carryOrigin({...message,content:parts.map(part=>({type:"provider_native",part}))});
    }
    // A provider switch preserves generated media through the canonical format;
    // unsupported target media is rejected by its protocol adapter explicitly.
    if(state.media.length)return carryOrigin({...message,content:[{type:"text",text:content},...state.media.map(media=>
      media.mimeType.startsWith("image/")?{type:"image_url",image_url:{url:`data:${media.mimeType};base64,${media.data}`}}
        :media.mimeType.startsWith("audio/")?{type:"audio_url",audio_url:{url:`data:${media.mimeType};base64,${media.data}`}}
        :{type:"video_url",video_url:{url:`data:${media.mimeType};base64,${media.data}`}})]});
    return carryOrigin(message);
  });
}

function inputMessages(input: Record<string, unknown>, protocol: CompletionProtocol): Array<Record<string, any>> {
  if (!Array.isArray(input.messages)) throw new ModelRequestError("模型请求缺少消息。", 400);
  const messages = structuredClone(input.messages) as Array<Record<string, any>>;
  let leadingSystem = true;
  for (const message of messages) {
    if (message.role === "developer") message.role = "system";
    // Claude/Google system text cannot hold image parts. The fixed Tavern
    // converters extract leading system content as text without inspecting it;
    // an image control in an empty story must remain a content turn instead.
    // Preserve every text-only system and non-leading message's original role.
    if (leadingSystem && message.role === "system" && Array.isArray(message.content)
      && message.content.some((part: Record<string, unknown>) => part.type === "image_url")) message.role = "user";
    if (message.role !== "system") leadingSystem = false;
    if (!Array.isArray(message.content)) { message.content ??= ""; continue; }
    message.content = message.content.map((raw: unknown) => {
      const part = object(raw);
      if (part.type === "input_audio" && protocol === "gemini") {
        const audio = object(part.input_audio);
        return {type:"audio_url",audio_url:{url:`data:audio/${audio.format === "wav" ? "wav" : "mpeg"};base64,${audio.data}`}};
      }
      if (part.type === "image_url") {
        const url=object(part.image_url).url;
        if (typeof url !== "string" || !url.startsWith("data:")) {
          if (protocol === "claude" && typeof url === "string" && /^https?:\/\//.test(url)) return {type:"image",source:{type:"url",url}};
          throw new ModelRequestError("该原生协议需要内嵌图片数据；请先将图片转换为 data URI。", 400);
        }
      }
      if (protocol === "gemini" && ["audio_url","video_url"].includes(part.type)
        && !String(object(part[part.type]).url ?? "").startsWith("data:"))
        throw new ModelRequestError("该原生协议需要内嵌音频或视频数据。",400);
      if (protocol === "claude" && ["audio_url","input_audio","video_url"].includes(part.type))
        throw new ModelRequestError("Claude Messages 不支持该音频或视频内容。",400);
      return part;
    });
  }
  return messages;
}
function names(input: Record<string, unknown>) {
  const groupNames=Array.isArray(input.group_names)?input.group_names.filter((v):v is string=>typeof v==="string"):[];
  return {userName:String(input.user_name??""),charName:String(input.char_name??""),groupNames,
    startsWithGroupName:(content:string)=>groupNames.some(name=>content.startsWith(name+": "))};
}

/** Converts cloned canonical Tavern messages using the fixed upstream declarations. */
export function providerRequestBody(protocol: CompletionProtocol, input: Record<string, unknown>): Record<string, unknown> {
  input={...input,messages:replayProviderResponseMessages(input.messages,protocol,String(input.model??""))};
  if (protocol === "openai") return input;
  const messages=inputMessages(input,protocol), model=String(input.model??"");
  const useSystem=input.use_sysprompt !== false;
  const tools=Array.isArray(input.tools)?input.tools:[];
  const json=object(input.json_schema ?? object(input.response_format).json_schema);
  const schema=json.value??json.schema;
  if (protocol === "claude") {
    const converted=convertClaudeMessages(messages,input.assistant_prefill??"",useSystem,tools.length>0||!!schema,names(input));
    const body:Record<string,any>={model,messages:converted.messages,max_tokens:input.max_tokens??input.max_completion_tokens??1024,stream:!!input.stream};
    if (useSystem && converted.systemPrompt.length) body.system=converted.systemPrompt;
    for (const key of ["temperature","top_p","top_k"]) if (input[key]!==undefined) body[key]=input[key];
    if (Array.isArray(input.stop)&&input.stop.length) body.stop_sequences=input.stop;
    if (tools.length) {
      body.tools=tools.map(raw=>object(raw)).filter(tool=>tool.type==="function").map(tool=>({
        name:tool.function.name,description:tool.function.description,input_schema:structuredClone(tool.function.parameters??{type:"object",properties:{}})}));
      const choice=object(input.tool_choice);
      body.tool_choice=choice.function?.name?{type:"tool",name:choice.function.name}:{type:input.tool_choice==="required"?"any":input.tool_choice??"auto"};
    }
    if (schema) {
      body.tools=[...(body.tools??[]),{name:json.name??"structured_output",description:json.description??"Well-formed JSON object",input_schema:schema}];
      body.tool_choice={type:"tool",name:json.name??"structured_output"};
    }
    const adaptive=/claude-(opus-4-6|sonnet-4-6|opus-4-7|opus-4-8|fable|opus-5|sonnet-5)/.test(model);
    const thinkingModel=adaptive||/^claude-(3-7|opus-4|sonnet-4|haiku-4-5)/.test(model);
    const thinking=calculateClaudeBudgetTokens(body.max_tokens,input.reasoning_effort??"auto",!!input.stream,adaptive);
    if (thinkingModel && typeof thinking === "string") {body.thinking={type:"adaptive"};body.output_config={effort:thinking};delete body.top_k;}
    else if (thinkingModel && Number.isInteger(thinking)) {
      // Do not secretly increase output reserve after the caller measured its budget.
      if (body.max_tokens<=1024) throw new ModelRequestError("Claude 思考模式需要大于 1024 的回复上限。",400);
      body.thinking={type:"enabled",budget_tokens:thinking};for(const key of ["temperature","top_p","top_k"])delete body[key];
    }
    if (/claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(model)) {
      if(Number(body.top_p)<1)delete body.temperature;else delete body.top_p;
    }
    if (/claude-(opus-4-7|opus-4-8|fable|opus-5|sonnet-5)/.test(model)) for(const key of ["temperature","top_p","top_k"])delete body[key];
    if ((body.thinking||adaptive)&&converted.messages.at(-1)?.role==="assistant") converted.messages.at(-1).role="user";
    // Signed reasoning is replayed as its original content blocks. Text is never substituted for a signature.
    return body;
  }
  const prompt=convertGooglePrompt(messages,model,useSystem,names(input));
  const generation:Record<string,unknown>={maxOutputTokens:input.max_tokens??input.max_completion_tokens??1024};
  for(const [key,native] of [["temperature","temperature"],["top_p","topP"],["top_k","topK"],["stop","stopSequences"],["seed","seed"]])
    if(key && native && input[key]!==undefined)generation[native]=input[key];
  if(schema){generation.responseMimeType="application/json";generation.responseJsonSchema=schema;}
  if (Array.isArray(input.response_modalities)) generation.responseModalities=input.response_modalities;
  if (input.image_config) generation.imageConfig=input.image_config;
  if (/^gemini-(2\.5-(flash|pro)|3[.\d]*-(flash|pro))/.test(model)&&!/-image/.test(model)) {
    const thinking=calculateGoogleBudgetTokens(Number(generation.maxOutputTokens),input.reasoning_effort??"auto",model);
    generation.thinkingConfig={includeThoughts:!!input.include_reasoning,...(typeof thinking==="number"?{thinkingBudget:thinking}:typeof thinking==="string"?{thinkingLevel:thinking}:{})};
  }
  if (/gemini-3\.[67]-flash|gemini-3\.5-flash-lite/.test(model)) for(const key of ["temperature","topP","topK"])delete generation[key];
  const body:Record<string,unknown>={contents:prompt.contents,generationConfig:generation};
  if(useSystem&&prompt.system_instruction.parts.length)body.systemInstruction=prompt.system_instruction;
  if(input.safety_settings)body.safetySettings=input.safety_settings;
  if(tools.length){
    body.tools=[{functionDeclarations:tools.map(raw=>object(raw)).filter(tool=>tool.type==="function").map(tool=>{
      const fn=structuredClone(tool.function);if(fn.parameters?.$schema)delete fn.parameters.$schema;
      if(fn.parameters?.properties&&Object.keys(fn.parameters.properties).length===0)delete fn.parameters;
      return fn;
    })}];
    const choice=object(input.tool_choice),mode=input.tool_choice==="none"?"NONE":input.tool_choice==="required"||choice.function?.name?"ANY":"AUTO";
    body.toolConfig={functionCallingConfig:{mode,...(choice.function?.name?{allowedFunctionNames:[choice.function.name]}:{})}};
  }
  return body;
}

export interface CompletionTransport {
  baseUrl: string; apiKey?: string | undefined; body: Record<string, unknown>; extraHeaders: Record<string, string>; protocol: CompletionProtocol;
}
export function requestProviderCompletion(transport: CompletionTransport, signal: AbortSignal): Promise<Response> {
  const {protocol,baseUrl,body,apiKey}=transport;
  const wire=providerRequestBody(protocol,body);
  const path=protocol==="claude"?"messages":protocol==="gemini"
    ?`models/${encodeURIComponent(String(body.model).replace(/^models\//,""))}:${body.stream?"streamGenerateContent":"generateContent"}`:"chat/completions";
  const url=endpoint(baseUrl,path);
  if(protocol==="gemini"&&body.stream)url.searchParams.set("alt","sse");
  const headers=new Headers({"Content-Type":"application/json",Accept:body.stream?"text/event-stream":"application/json"});
  if(protocol==="claude"){headers.set("anthropic-version","2023-06-01");if(apiKey)headers.set("x-api-key",apiKey);}
  else if(protocol==="gemini"){if(apiKey)headers.set("x-goog-api-key",apiKey);}
  else if(apiKey)headers.set("Authorization",`Bearer ${apiKey}`);
  for(const [name,value]of Object.entries(transport.extraHeaders))headers.set(name,value);
  // Redirects must not forward a selected profile's credential to a new scope.
  const headerObject=Object.fromEntries([...headers].map(([key,value])=>[key==="authorization"?"Authorization":key,value]));
  return fetch(url,{method:"POST",headers:headerObject,signal,redirect:"error",body:JSON.stringify(wire)});
}

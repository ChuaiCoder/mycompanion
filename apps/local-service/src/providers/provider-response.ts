import { createParser } from "eventsource-parser";
import type { ModelCandidateSnapshot, ModelResponseState, ProviderTokenUsage } from "@mycompanion/shared";
import type { CompletionProtocol } from "./provider-transport.js";
import { ModelRequestError } from "./model-request-error.js";
import { providerHttpError, providerPayloadError } from "./provider-errors.js";
import { readProviderTokenUsage } from "./provider-usage.js";

const object=(value:unknown):Record<string,any>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,any>:{};
const array=(value:unknown):Array<Record<string,any>>=>Array.isArray(value)?value.map(object):[];
const text=(value:unknown):string=>typeof value==="string"?value:"";
export function normalizedFinishReason(protocol:CompletionProtocol,reason:unknown):string {
  const value=text(reason);
  if(protocol==="claude")return ["end_turn","stop_sequence","pause_turn"].includes(value)?"stop"
    :["max_tokens","model_context_window_exceeded"].includes(value)?"length":value==="tool_use"?"tool_calls":value||"eof";
  if(protocol==="gemini")return value==="STOP"?"stop":value==="MAX_TOKENS"?"length":value||"eof";
  return value||"eof";
}
export interface ProviderReply {
  text:string; state:ModelResponseState; finishReason:string; usage?:ProviderTokenUsage;
  candidates?:ModelCandidateSnapshot[];
}
function choiceIndex(choice:Record<string,any>,explicit:boolean):number {
  const index=choice.index??(explicit?undefined:0);
  if(typeof index!=="number"||!Number.isSafeInteger(index)||index<0)
    throw new ModelRequestError("模型返回了无效的候选序号。",502);
  return index;
}
export function emptyResponseState(protocol:CompletionProtocol):ModelResponseState {
  return {protocol,reasoning:"",signature:"",toolCalls:[],media:[],providerContent:[]};
}
function claudeState(blocks:Array<Record<string,any>>,state:ModelResponseState):string {
  state.providerContent=structuredClone(blocks);
  state.reasoning=blocks.filter(part=>part.type==="thinking").map(part=>text(part.thinking)).join("");
  state.signature=blocks.filter(part=>part.type==="thinking").map(part=>text(part.signature)).join("");
  state.toolCalls=blocks.filter(part=>part.type==="tool_use").map(part=>({id:text(part.id),type:"function",function:{name:text(part.name),
    arguments:typeof part._partialJson==="string"?part._partialJson:JSON.stringify(part.input??{})}}));
  for(const part of state.providerContent)delete part._partialJson;
  return blocks.filter(part=>part.type==="text").map(part=>text(part.text)).join("");
}
function addGeminiParts(parts:Array<Record<string,any>>,state:ModelResponseState):string {
  let result="";
  for(const part of parts){
    state.providerContent.push(structuredClone(part));
    if(part.thought)state.reasoning+=text(part.text);else result+=text(part.text);
    if(part.thoughtSignature&&typeof part.text==="string")state.signature=text(part.thoughtSignature);
    if(part.functionCall){const fn=object(part.functionCall);state.toolCalls.push({id:text(fn.id)||`call_${state.toolCalls.length}`,type:"function",
      function:{name:text(fn.name),arguments:JSON.stringify(fn.args??{})},...(part.thoughtSignature?{signature:text(part.thoughtSignature)}:{})});}
    const data=object(part.inlineData??part.inline_data);
    if(typeof data.data==="string"&&typeof (data.mimeType??data.mime_type)==="string")state.media.push({mimeType:data.mimeType??data.mime_type,data:data.data,
      ...(part.thoughtSignature?{signature:text(part.thoughtSignature)}:{})});
  }
  return result;
}
function addOpenAIMessage(message:Record<string,any>,state:ModelResponseState):string {
  state.reasoning+=text(message.reasoning_content??message.reasoning);
  if(message.signature)state.signature=text(message.signature);
  state.toolCalls=array(message.tool_calls).map(call=>({id:text(call.id),type:"function",function:{name:text(call.function?.name),arguments:
    typeof call.function?.arguments==="string"?call.function.arguments:JSON.stringify(call.function?.arguments??{})},...(call.signature?{signature:text(call.signature)}:{})}));
  if(message.audio?.data)state.media.push({mimeType:message.audio.format==="wav"?"audio/wav":"audio/mpeg",data:text(message.audio.data)});
  let result=typeof message.content==="string"?message.content:"";
  for(const part of array(message.content)) {
    if(part.type==="text")result+=text(part.text);
    const url=part.image_url?.url;if(typeof url==="string"){
      const match=/^data:([^;]+);base64,(.*)$/s.exec(url);if(match)state.media.push({mimeType:match[1]!,data:match[2]!});
    }
  }
  state.providerContent=array(message.content);
  return result;
}
export function decodeProviderReply(protocol:CompletionProtocol,value:unknown,input:Record<string,unknown>={},
  onCandidates?:(candidates:ModelCandidateSnapshot[])=>void):ProviderReply {
  const error=providerPayloadError(value);if(error)throw error;
  const data=object(value),state=emptyResponseState(protocol);let result="",reason:unknown;
  if(typeof input.model==="string"&&input.model)state.model=input.model;
  if(protocol==="openai") {
    const choices=array(data.choices),candidates:ModelCandidateSnapshot[]=[],explicit=Number(input.n)>1||choices.length>1;
    for(const choice of choices){
      const index=choiceIndex(choice,explicit);if(candidates.some(candidate=>candidate.index===index))throw new ModelRequestError("模型返回了重复的候选序号。",502);
      const responseState=emptyResponseState(protocol);if(state.model)responseState.model=state.model;
      candidates.push({index,content:addOpenAIMessage(object(choice.message),responseState),responseState,finishReason:text(choice.finish_reason)||"response"});
      if(explicit||candidates.some(candidate=>candidate.index>0))onCandidates?.(structuredClone([...candidates].sort((a,b)=>a.index-b.index)));
    }
    candidates.sort((a,b)=>a.index-b.index);const selected=candidates.find(candidate=>candidate.index===0),usage=readProviderTokenUsage(data,undefined,protocol);
    return {text:selected?.content??"",state:selected?.responseState??state,finishReason:selected?.finishReason??"missing_choice",
      ...(explicit||candidates.some(candidate=>candidate.index>0)?{candidates}:{}),...(usage?{usage}:{})};
  }
  if(protocol==="claude") {result=claudeState(array(data.content),state);reason=data.stop_reason;}
  else if(protocol==="gemini") {const candidate=array(data.candidates)[0]??{};result=addGeminiParts(array(candidate.content?.parts),state);reason=candidate.finishReason;}
  else {const choice=array(data.choices)[0]??{};result=addOpenAIMessage(object(choice.message),state);reason=choice.finish_reason??"response";}
  const schema=object(input.json_schema??object(input.response_format).json_schema);
  const schemaCall=state.toolCalls.find(call=>call.function.name===(schema.name??"structured_output"));
  if(protocol==="claude"&&Object.keys(schema).length&&schemaCall){result=schemaCall.function.arguments;reason="end_turn";}
  const usage=readProviderTokenUsage(data,undefined,protocol);
  return {text:result,state,finishReason:normalizedFinishReason(protocol,reason),...(usage?{usage}:{})};
}
/** Public non-stream endpoint follows Tavern's wrapped response shape and retains native blocks. */
export function tavernProviderReply(protocol:CompletionProtocol,value:unknown,input:Record<string,unknown>):Record<string,unknown> {
  const data=object(value);
  if(protocol==="openai")return data;
  const decoded=decodeProviderReply(protocol,data,input);
  const schema=object(input.json_schema??object(input.response_format).json_schema);
  const schemaCall=decoded.state.toolCalls.find(call=>call.function.name===(schema.name??"structured_output"));
  const content=protocol==="claude"&&Object.keys(schema).length&&schemaCall?schemaCall.function.arguments:decoded.text;
  return {...data,choices:[{message:{role:"assistant",content,reasoning:decoded.state.reasoning,signature:decoded.state.signature,
    ...(decoded.state.toolCalls.length?{tool_calls:decoded.state.toolCalls}:{}),...(decoded.state.media.length?{media:decoded.state.media}:{})},finish_reason:decoded.finishReason}],
    ...(protocol==="gemini"?{responseContent:object(array(data.candidates)[0]?.content)}:{})};
}
export async function readProviderJson(response:Response):Promise<Record<string,unknown>> {
  let data:unknown;try{data=await response.json();}catch{throw new ModelRequestError("模型返回了不兼容的响应格式。",502);}
  const error=providerPayloadError(data);if(error)throw error;
  if(!data||typeof data!=="object"||Array.isArray(data))throw new ModelRequestError("模型返回了不兼容的响应格式。",502);
  return data as Record<string,unknown>;
}

/** Native response state is accumulated per block/call ordinal, never by text or tool name. */
export async function readProviderStream(protocol:CompletionProtocol,response:Response,callbacks:{
  model?:string;n?:number;onDelta:(delta:string)=>void;onState?:(state:ModelResponseState)=>void;onUsage?:(usage:ProviderTokenUsage)=>void;
  onCandidates?:(candidates:ModelCandidateSnapshot[])=>void;
}):Promise<ProviderReply> {
  if(!response.body)throw new ModelRequestError("模型服务没有提供流式响应。",502);
  let state=emptyResponseState(protocol);const claudeBlocks:Array<Record<string,any>>=[];
  if(callbacks.model)state.model=callbacks.model;
  let full="",terminal=false,finishReason:string|undefined,usage:ProviderTokenUsage|undefined;
  const candidates=new Map<number,ModelCandidateSnapshot>(),calls=new Map<number,Map<number,ModelResponseState["toolCalls"][number]>>();
  let multi=protocol==="openai"&&Number(callbacks.n)>1;
  const snapshot=()=>{if(multi)callbacks.onCandidates?.(structuredClone([...candidates.values()].sort((a,b)=>a.index-b.index)));};
  let stateDirty=false;
  const emit=(delta:string)=>{if(delta){full+=delta;callbacks.onDelta(delta);}
    // 状态没变就不发射也不拷贝：纯文本 delta 占绝大多数，此前每个 delta 都对
    // 整个 state structuredClone 一次。发射时机仍保留中间态（调用方契约）。
    if(stateDirty){stateDirty=false;callbacks.onState?.(structuredClone(state));}};
  const parser=createParser({onEvent:event=>{
    if(terminal)return;
    if(event.data.trim()==="[DONE]"){terminal=true;for(const candidate of candidates.values())candidate.finishReason??="done";snapshot();return;}
    let parsed:unknown;try{parsed=JSON.parse(event.data);}catch{throw new ModelRequestError("模型返回了不兼容的响应格式。",502);}
    const data=object(parsed),error=event.event==="error"?providerHttpError(502):providerPayloadError(data);if(error)throw error;
    const nextUsage=readProviderTokenUsage(data,usage,protocol);if(nextUsage&&nextUsage!==usage){usage=nextUsage;callbacks.onUsage?.(usage);}
    if(protocol==="claude"){
      const index=Number(data.index),block=claudeBlocks[index];let delta="";
      if(data.type==="content_block_start"&&Number.isSafeInteger(index)&&index>=0){
        claudeBlocks[index]=structuredClone(object(data.content_block));
        delta=text(data.content_block?.type==="text"?data.content_block.text:undefined);
      }else if(data.type==="content_block_delta"&&block){
        const part=object(data.delta);
        if(part.type==="text_delta"){delta=text(part.text);block.text=text(block.text)+delta;}
        if(part.type==="thinking_delta")block.thinking=text(block.thinking)+text(part.thinking);
        if(part.type==="signature_delta")block.signature=text(block.signature)+text(part.signature);
        if(part.type==="input_json_delta")block._partialJson=text(block._partialJson)+text(part.partial_json);
      }else if(data.type==="content_block_stop"&&block&&typeof block._partialJson==="string"){
        try{block.input=JSON.parse(block._partialJson);}catch{throw new ModelRequestError("模型返回了无效的工具参数。",502);}delete block._partialJson;
      }
      if(data.type==="message_delta"&&data.delta?.stop_reason)finishReason=normalizedFinishReason(protocol,data.delta.stop_reason);
      if(data.type==="message_stop")terminal=true;
      claudeState(claudeBlocks.filter(Boolean),state);stateDirty=true;emit(delta);
    }else if(protocol==="gemini"){
      const candidate=array(data.candidates)[0]??{};
      if(candidate.finishReason)finishReason=normalizedFinishReason(protocol,candidate.finishReason);
      stateDirty=true;emit(addGeminiParts(array(candidate.content?.parts),state));
    }else{
      const choices=array(data.choices);if(choices.length>1||choices.some(choice=>typeof choice.index==="number"&&choice.index>0))multi=true;
      for(const choice of choices){
        const index=choiceIndex(choice,multi),delta=object(choice.delta);
        let candidate=candidates.get(index);if(!candidate){const responseState=emptyResponseState("openai");if(callbacks.model)responseState.model=callbacks.model;
          candidate={index,content:"",responseState};candidates.set(index,candidate);}
        const current=candidate.responseState;if(choice.finish_reason)candidate.finishReason=text(choice.finish_reason);
        const reasoningText=text(delta.reasoning_content??delta.reasoning);
        if(reasoningText){current.reasoning+=reasoningText;stateDirty=true;}
        if(delta.signature){current.signature=text(delta.signature);stateDirty=true;}
        const deltaCalls=array(delta.tool_calls);
        const ordinals=calls.get(index)??new Map<number,ModelResponseState["toolCalls"][number]>();calls.set(index,ordinals);
        for(const call of deltaCalls){
          const ordinal=call.index??0;if(typeof ordinal!=="number"||!Number.isSafeInteger(ordinal)||ordinal<0)throw new ModelRequestError("模型返回了无效的工具序号。",502);
          let target=ordinals.get(ordinal);if(!target){target={id:"",type:"function",function:{name:"",arguments:""}};ordinals.set(ordinal,target);}
          if(call.id)target.id=text(call.id);target.function.name+=text(call.function?.name);target.function.arguments+=text(call.function?.arguments);
          if(call.signature)target.signature=text(call.signature);
        }
        if(deltaCalls.length){current.toolCalls=[...ordinals].sort((a,b)=>a[0]-b[0]).map(([,call])=>call);stateDirty=true;}
        if(delta.audio?.data){current.media.push({mimeType:delta.audio.format==="wav"?"audio/wav":"audio/mpeg",data:text(delta.audio.data)});stateDirty=true;}
        const chunk=typeof delta.content==="string"?delta.content:array(delta.content).map(part=>text(part.text)).join("");candidate.content+=chunk;
        const contentParts=array(delta.content);
        for(const part of contentParts){
          current.providerContent.push(structuredClone(part));const match=/^data:([^;]+);base64,(.*)$/s.exec(text(part.image_url?.url));
          if(match)current.media.push({mimeType:match[1]!,data:match[2]!});
        }
        if(contentParts.length)stateDirty=true;
        if(index===0){state=current;finishReason=candidate.finishReason;emit(chunk);}
        snapshot();
      }
      snapshot();
    }
  }});
  const reader=response.body.getReader(),decoder=new TextDecoder();
  try{while(!terminal){const {done,value}=await reader.read();if(done){parser.feed(decoder.decode());break;}parser.feed(decoder.decode(value,{stream:true}));}}
  finally{try{await reader.cancel();}catch{}reader.releaseLock();}
  if(protocol==="openai"){
    for(const candidate of candidates.values())candidate.finishReason??=terminal?"done":"eof";snapshot();
    if(multi&&!candidates.has(0))finishReason="missing_choice";
  }
  return {text:full,state,finishReason:finishReason??(terminal?"done":"eof"),...(multi?{candidates:[...candidates.values()].sort((a,b)=>a.index-b.index)}:{}),...(usage?{usage}:{})};
}

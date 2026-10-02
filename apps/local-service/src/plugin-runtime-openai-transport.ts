export const openAITransportSource = String.raw`
import {eventSource, event_types, getRequestHeaders, getContext} from '/plugin-runtime/compat-runtime.js';
import {getEventSourceStream} from '/scripts/sse-stream.js';
import {oai_settings,refreshOpenAISettings,getChatCompletionModel,openai_max_stop_strings} from '/plugin-runtime/openai-settings.js';
import {markProviderConnected,getProviderRevision} from '/plugin-runtime/provider-status.js';
import {getCustomStoppingStrings,power_user} from '/scripts/power-user.js';
import {substituteParams} from '/plugin-runtime/macros.js';

const multiswipeSources = ['openai','azure_openai','custom','xai','aimlapi','moonshot'];
const canUseMultiSwipe = (type,settings) => Number(settings.n)>1 && !['quiet','impersonate','continue'].includes(type) && multiswipeSources.includes(settings.chat_completion_source);

// Shared construction for native preflight and the public extension transport.
// The explicit model and settings are request snapshots, never global overrides.
export function buildChatCompletionRequest(type, messages, settings, responseLength = 0, jsonSchema = null, model = getChatCompletionModel(settings)) {
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
    const source = settings.chat_completion_source;
    const gptSource = ['openai','azure_openai','openrouter'].includes(source);
    const context = getContext();
    const request = {type,messages: structuredClone(messages.filter(message=>message && typeof message==='object')), model, temperature:Number(settings.temp_openai),
      max_tokens:responseLength > 0 ? responseLength : settings.openai_max_tokens,
      stream:type !== 'quiet' && Boolean(settings.stream_openai) && !(gptSource && ['o1','o1-2024-12-17'].includes(model)) && !(source==='workers_ai' && jsonSchema),
      chat_completion_source:source, _mycompanion_context_limit:Number(settings.openai_max_context),
      frequency_penalty:Number(settings.freq_pen_openai),presence_penalty:Number(settings.pres_pen_openai),top_p:Number(settings.top_p_openai),
      user_name:context.name1,char_name:context.name2,include_reasoning:Boolean(settings.show_thoughts),
      ...(canUseMultiSwipe(type,settings) ? {n:Number(settings.n)} : {}),
      ...(jsonSchema ? {json_schema:structuredClone(jsonSchema)} : {})};
    // OpenAI rejects top_k. Retain the existing custom-endpoint setting only
    // when explicitly enabled; backend-specific fields are not universal.
    if(source==='custom' && Number(settings.top_k_openai)>0)request.top_k=Number(settings.top_k_openai);
    if (['openai','azure_openai','openrouter','mistralai','custom','cohere','groq','electronhub','nanogpt','xai','pollinations','aimlapi','vertexai','makersuite','chutes'].includes(source) && settings.seed>=0) request.seed=Number(settings.seed);
    const stops=getCustomStoppingStrings(openai_max_stop_strings);
    if(stops.length)request.stop=stops;
    if(power_user.request_token_probabilities && ['openai','azure_openai','openrouter','custom','deepseek','xai','aimlapi','chutes'].includes(source))request.logprobs=5;
    for(const key of ['custom_url','reverse_proxy','proxy_password','reasoning_effort','verbosity']) if(settings[key])request[key]=settings[key];
    if(source==='custom')for(const key of ['custom_include_body','custom_exclude_body','custom_include_headers'])if(settings[key])request[key]=substituteParams(settings[key]);
    if(gptSource && (/^(o1|o3|o4)/.test(model) || source==='openrouter' && /^openai\/(o1|o3|o4)/.test(model))) {
      request.max_completion_tokens=request.max_tokens;
      for(const key of ['max_tokens','logprobs','stop','temperature','top_p','frequency_penalty','presence_penalty'])delete request[key];
      if(/^(openai\/)?o1/.test(model)){for(const message of request.messages)if(message.role==='system')message.role='user';delete request.n;}
    }
    return request;
}

export async function createGenerationParameters(settings, model, type, messages, {jsonSchema = null, responseLength = 0} = {}) {
    const generate_data=buildChatCompletionRequest(type,messages,settings,responseLength,jsonSchema,model);
    return {generate_data,stream:generate_data.stream,canMultiSwipe:canUseMultiSwipe(type,settings)};
}

export function tryParseStreamingError(response, decoded, {quiet = false} = {}) {
  let data; try { data = JSON.parse(decoded); } catch { return; }
  if (!data || !(data.error || data.message || data.detail || data.quota_error || data.moderation_error)) return;
  const detail = data.error?.message || data.error || data.message || data.detail || (data.quota_error ? 'API quota exceeded' : 'API moderation error');
  const message = typeof detail === 'string' ? detail : JSON.stringify(detail);
  if (!quiet) globalThis.toastr?.error(message, 'Chat Completion API');
  throw new Error(message);
}
export function getStreamingReply(data, state, {chatCompletionSource = null, overrideShowThoughts = null} = {}) {
  const source = chatCompletionSource ?? oai_settings.chat_completion_source, thoughts = overrideShowThoughts ?? oai_settings.show_thoughts;
  state.reasoning ??= ''; state.images ??= []; state.signature ??= ''; state.toolSignatures ??= {};
  const choices = data?.choices || [], first = choices[0] || {}, delta = first.delta || {}, message = first.message || {};
  const addReasoning = value => { if (thoughts && typeof value === 'string') state.reasoning += value; };
  const text = value => typeof value === 'string' ? value : '';
  if (source === 'claude') { addReasoning(data?.delta?.thinking); return text(data?.delta?.text); }
  if (source === 'makersuite' || source === 'vertexai') {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (!part.thought && part.inlineData?.mimeType && part.inlineData?.data) state.images.push('data:' + part.inlineData.mimeType + ';base64,' + part.inlineData.data);
      if (part.thoughtSignature && typeof part.text === 'string') state.signature = part.thoughtSignature;
    }
    addReasoning(parts.find(part => part.thought)?.text);
    return text(parts.find(part => !part.thought && typeof part.text === 'string')?.text);
  }
  if (source === 'cohere') return text(data?.delta?.message?.content?.text ?? data?.delta?.message?.tool_plan);
  if (source === 'openrouter') {
    for (const image of delta.images || []) if (image.type === 'image_url' && /^data:/.test(image.image_url?.url || '')) state.images.push(image.image_url.url);
    const reasoning = choices.find(item => item.delta?.reasoning)?.delta?.reasoning ?? choices.find(item => item.delta?.reasoning_content)?.delta?.reasoning_content ?? choices.find(item => item.message?.reasoning)?.message?.reasoning ?? choices.find(item => item.message?.reasoning_content)?.message?.reasoning_content;
    addReasoning(reasoning);
    for (const detail of [...(delta.reasoning_details || []), ...(message.reasoning_details || [])]) {
      if (detail.type !== 'reasoning.encrypted' || !detail.data) continue;
      if (typeof detail.id === 'string' && detail.id) Object.defineProperty(state.toolSignatures, detail.id, {value:detail.data, configurable:true, enumerable:true, writable:true});
      if (!(typeof detail.id === 'string' && /^(tool_|call_)/.test(detail.id))) state.signature = detail.data;
    }
  } else if (source === 'mistralai') addReasoning(delta.content?.[0]?.thinking?.[0]?.text);
  else if (source !== 'openai') addReasoning(choices.find(item => item.delta?.reasoning_content)?.delta?.reasoning_content ?? choices.find(item => item.delta?.reasoning)?.delta?.reasoning);
  const content = delta.content ?? message.content ?? first.text ?? '';
  return Array.isArray(content) ? content.map(part => text(part.text)).join('') : text(content);
}

export async function sendOpenAIRequest(type, messages, signal, {jsonSchema = null, responseLength = null} = {}) {
  const providerRevision = getProviderRevision();
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Cancelled by stop event'));
  const abort = () => controller.abort(signal.reason);
  const clean = () => { eventSource.removeListener(event_types.GENERATION_STOPPED, stop); window.removeEventListener('pagehide', stop); signal?.removeEventListener('abort', abort); };
  eventSource.on(event_types.GENERATION_STOPPED, stop); window.addEventListener('pagehide', stop);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once:true});
  controller.signal.addEventListener('abort', clean, {once:true});
  let streaming = false;
  try {
    controller.signal.throwIfAborted();
    const settings=structuredClone(await refreshOpenAISettings(controller.signal));
    controller.signal.throwIfAborted();
    const {generate_data:request} = await createGenerationParameters(settings,getChatCompletionModel(settings),type,messages,{responseLength,jsonSchema});
    await eventSource.emitChecked(event_types.CHAT_COMPLETION_SETTINGS_READY, request);
    controller.signal.throwIfAborted();
    const response = await fetch('/api/backends/chat-completions/generate', {method:'POST',headers:getRequestHeaders(),body:JSON.stringify(request),signal:controller.signal});
    if (!response.ok) { tryParseStreamingError(response, await response.text()); throw new Error('Got response status ' + response.status); }
    markProviderConnected(request.model, providerRevision);
    if (!request.stream) {
      const decoded = await response.text(); tryParseStreamingError(response, decoded); return JSON.parse(decoded);
    }
    if (!response.body) throw new Error('Response body is null');
    streaming = true; let started = false;
    return async function* streamData() {
      if (started) throw new Error('The generation stream has already been consumed'); started = true;
      const reader = response.body.pipeThrough(getEventSourceStream()).getReader();
      let text = ''; const swipes = [], toolCalls = [], state = {reasoning:'',images:[],signature:'',toolSignatures:{}};
      try {
        while (true) {
          const {done,value} = await reader.read(); if (done || value.data === '[DONE]') return;
          tryParseStreamingError(response,value.data);
          const parsed = JSON.parse(value.data);
          for (const choice of parsed.choices || []) {
            const index = choice.index || 0;
            const chunk = getStreamingReply({...parsed,choices:[choice]}, state, {chatCompletionSource:request.chat_completion_source,overrideShowThoughts:index === 0});
            if (index > 0) swipes[index - 1] = (swipes[index - 1] || '') + chunk; else text += chunk;
            if (index === 0) for (const item of choice.delta?.tool_calls || []) {
              const target = toolCalls[item.index ?? 0] ??= {id:'',type:'function',function:{name:'',arguments:''}};
              if (item.id) target.id = item.id;
              if (item.type) target.type = item.type;
              if (item.function?.name) target.function.name += item.function.name;
              if (item.function?.arguments) target.function.arguments += item.function.arguments;
              if (item.signature) target.signature = item.signature;
              if (state.toolSignatures[target.id]) target.signature = state.toolSignatures[target.id];
            }
          }
          for (const call of toolCalls) if (call && state.toolSignatures[call.id]) call.signature = state.toolSignatures[call.id];
          const probabilities = parsed.choices?.[0]?.logprobs?.content;
          const logprobs = Array.isArray(probabilities) ? probabilities.map(item => {
            const topLogprobs = (item.top_logprobs || []).map(candidate => [candidate.token,candidate.logprob]);
            if (!topLogprobs.some(candidate => candidate[0] === item.token)) topLogprobs.push([item.token,item.logprob]);
            return {token:item.token,topLogprobs};
          }) : null;
          yield {text,swipes,toolCalls,state,logprobs};
        }
      } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); controller.abort(); clean(); }
    };
  } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
  finally { if (!streaming) clean(); }
}
`;

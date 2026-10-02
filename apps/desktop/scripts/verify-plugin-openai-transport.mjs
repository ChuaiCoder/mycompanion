import assert from 'node:assert/strict';
import {createServer} from 'node:http';

export async function verifyPluginOpenAITransport(window, service) {
  const requests = [], closed = new Set(), stages = [];
  const model = createServer(async (request,response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body); const input = body.messages[0].content;
    response.on('close', () => closed.add(input));
    if (input === 'HTTP_ERROR') { response.writeHead(429,{'Content-Type':'application/json'}); response.end('{"error":{"message":"Fixture quota"}}');return; }
    if (!body.stream) { response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{content:'Quiet reply',reasoning_content:'Quiet thought'}}]}));return; }
    response.writeHead(200,{'Content-Type':'text/event-stream'});
    const send = value => response.write('data: ' + JSON.stringify(value) + '\n\n');
    if (input.startsWith('HOLD') || input === 'BREAK') { send({choices:[{index:0,delta:{content:'Partial'}}]});return; }
    if (input === 'STREAM_ERROR') { send({error:{message:'Fixture stream failure'}});return; }
    const events = [
      {choices:[{index:0,delta:{content:'你',reasoning_content:'推',tool_calls:[{index:0,id:'call1',type:'function',function:{name:'weather',arguments:'{"city":"'}}]}},{index:1,delta:{content:'Alternative'}}]},
      {choices:[{index:0,delta:{content:'好',reasoning_content:'理',tool_calls:[{index:0,function:{arguments:'上海"}'}}]},logprobs:{content:[{token:'好',logprob:-0.1,top_logprobs:[]}]}}]},
    ];
    const bytes = Buffer.from(events.map(value => 'data: ' + JSON.stringify(value) + '\r\n\r\n').join('') + 'data: [DONE]\n\n');
    let index = 0;
    const timer = setInterval(() => { if (response.destroyed || index >= bytes.length) {clearInterval(timer);return;} response.write(bytes.subarray(index,index+7));index+=7; },1);
    response.on('close',()=>clearInterval(timer));
    // Deliberately leave the connection open after DONE. Consumers must cancel.
  });
  await new Promise(resolve => model.listen(0,'127.0.0.1',resolve));
  const evaluate = source => window.webContents.executeJavaScript(source);
  const wait = async predicate => {const end=Date.now()+10000;while(!await predicate()){if(Date.now()>end)throw new Error('OpenAI transport wait timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
  try {
    assert.equal((await service.inject({method:'PUT',url:'/api/settings/provider',payload:{kind:'ollama',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'transport-model',temperature:1.2,maxTokens:2345}})).statusCode,200);
    const baseline = await evaluate(`(async()=>{window.transport=await import('/scripts/openai.js');window.transportCore=await import('/script.js');return JSON.stringify(transportCore.chat);})()`);
    const parser = await evaluate(`(()=>{
      const state={reasoning:'',images:[],signature:'',toolSignatures:{}};
      const text=transport.getStreamingReply({candidates:[{content:{parts:[{thought:true,text:'Thinking'},{text:'Gemini',thoughtSignature:'sig'},{inlineData:{mimeType:'image/png',data:'AA=='}}]}}]},state,{chatCompletionSource:'makersuite'});
      const disabled=transport.getStreamingReply({delta:{thinking:'Hidden',text:'Claude'}},state,{chatCompletionSource:'claude',overrideShowThoughts:false});
      transport.getStreamingReply({choices:[{delta:{reasoning_details:[{type:'reasoning.encrypted',id:'call1',data:'toolSig'},{type:'reasoning.encrypted',id:'message',data:'msgSig'}],images:[{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}}]},state,{chatCompletionSource:'openrouter'});
      const mistral=transport.getStreamingReply({choices:[{delta:{content:[{thinking:[{text:'Mistral thought'}]},{text:'Mistral'}]}}]},state,{chatCompletionSource:'mistralai'});
      let error='';try{transport.tryParseStreamingError({status:400},'not json',{quiet:true});transport.tryParseStreamingError({status:400},'{"error":{"message":"Readable error"}}',{quiet:true});}catch(value){error=value.message;}
      return {text,disabled,mistral,state,error};
    })()`);
    assert.equal(parser.text,'Gemini');assert.equal(parser.disabled,'Claude');assert.equal(parser.mistral,'Mistral');
    assert.equal(parser.state.reasoning,'ThinkingMistral thought');assert.equal(parser.state.signature,'msgSig');assert.equal(parser.state.toolSignatures.call1,'toolSig');assert.equal(parser.state.images.length,2);assert.equal(parser.error,'Readable error');
    stages.push('provider-specific-text-reasoning-images-signatures-and-readable-errors');

    const quiet = await evaluate(`(async()=>{
      const hook=async request=>{await Promise.resolve();request.max_tokens=3456;request.custom_include_body='extra: true';};
      transportCore.eventSource.on(transportCore.event_types.CHAT_COMPLETION_SETTINGS_READY,hook);
      try{return await transport.sendOpenAIRequest('quiet',[{role:'user',content:'QUIET'}]);}
      finally{transportCore.eventSource.removeListener(transportCore.event_types.CHAT_COMPLETION_SETTINGS_READY,hook);}
    })()`);
    assert.equal(quiet.choices[0].message.content,'Quiet reply');assert.equal(requests[0].max_tokens,3456);assert.equal(requests[0].extra,true);assert.equal(requests[0].temperature,1.2);
    stages.push('nonstream-request-uses-current-provider-and-awaited-settings-event');

    const stream = await evaluate(`(async()=>{const factory=await transport.sendOpenAIRequest('normal',[{role:'user',content:'STREAM'}]);const chunks=[];for await(const value of factory())chunks.push(structuredClone(value));return chunks;})()`);
    assert.equal(stream.at(-1).text,'你好');assert.equal(stream.at(-1).state.reasoning,'推理');assert.equal(stream.at(-1).swipes[0],'Alternative');
    assert.equal(stream.at(-1).toolCalls[0].function.arguments,'{"city":"上海"}');assert.equal(stream.at(-1).toolCalls[0].function.name,'weather');
    assert.deepEqual(stream.at(-1).logprobs,[{token:'好',topLogprobs:[['好',-0.1]]}]);
    assert.equal(stream[0].text,'你');await wait(()=>closed.has('STREAM'));
    stages.push('fragmented-utf8-sse-multiple-choices-tools-logprobs-and-done-connection-close');

    await evaluate(`(()=>{window.transportAbort=new AbortController();window.transportResults=[];window.transportPending=['HOLD_SIGNAL','HOLD_STOP'].map(async name=>{try{const factory=await transport.sendOpenAIRequest('normal',[{role:'user',content:name}],name==='HOLD_SIGNAL'?transportAbort.signal:undefined);for await(const value of factory()){transportResults.push(name+':'+value.text);}return 'unexpected';}catch(error){return error.message;}});})()`);
    await wait(()=>evaluate(`transportResults.length===2`));
    await evaluate(`transportAbort.abort(new Error('Explicit cancellation'))`);await wait(()=>closed.has('HOLD_SIGNAL'));
    await evaluate(`transportCore.stopGeneration()`);
    const cancelled=await evaluate(`Promise.all(transportPending)`);assert.match(cancelled[0],/Explicit cancellation/);assert.match(cancelled[1],/Cancelled/);await wait(()=>closed.has('HOLD_STOP'));
    stages.push('explicit-abort-and-global-stop-close-active-provider-connections');

    await evaluate(`(async()=>{const factory=await transport.sendOpenAIRequest('normal',[{role:'user',content:'BREAK'}]);for await(const value of factory()){break;}})()`);await wait(()=>closed.has('BREAK'));
    stages.push('early-generator-return-cancels-provider-without-an-explicit-stop');

    const errors=await evaluate(`(async()=>{const errors=[];for(const name of ['HTTP_ERROR','STREAM_ERROR']){try{const factory=await transport.sendOpenAIRequest('normal',[{role:'user',content:name}]);for await(const value of factory()){}errors.push('unexpected');}catch(error){errors.push(error.message);}}return errors;})()`);
    assert.deepEqual(errors,['Fixture quota','Fixture stream failure']);await wait(()=>closed.has('STREAM_ERROR'));
    stages.push('http-and-in-band-sse-errors-propagate-and-release-connection');

    const count=requests.length;
    const preflight=await evaluate(`(async()=>{const result=[];const controller=new AbortController();controller.abort(new Error('Already aborted'));try{await transport.sendOpenAIRequest('normal',[{role:'user',content:'UNSENT'}],controller.signal);}catch(error){result.push(error.message);}const hook=()=>{throw new Error('Settings hook failed');};transportCore.eventSource.on(transportCore.event_types.CHAT_COMPLETION_SETTINGS_READY,hook);try{await transport.sendOpenAIRequest('normal',[{role:'user',content:'UNSENT'}]);}catch(error){result.push(error.message);}finally{transportCore.eventSource.removeListener(transportCore.event_types.CHAT_COMPLETION_SETTINGS_READY,hook);}return result;})()`);
    assert.deepEqual(preflight,['Already aborted','Settings hook failed']);assert.equal(requests.length,count);
    assert.equal((await evaluate(`transport.sendOpenAIRequest('quiet',[{role:'user',content:'RECOVERY'}])`)).choices[0].message.content,'Quiet reply');
    assert.equal(await evaluate(`JSON.stringify(transportCore.chat)`),baseline);
    stages.push('preflight-failures-send-nothing-and-recovery-does-not-write-chat');
    const parameters=await evaluate(`(async()=>{
      const settings={...structuredClone(transport.oai_settings),openai_max_context:4096,openai_max_tokens:128,n:3,stream_openai:true};
      const messages=[null,42,{role:'system',content:'Rules'},{role:'user',content:'PARAMETERS'}];
      const before=JSON.stringify({settings,messages});
      const normal=await transport.createGenerationParameters(settings,'explicit-model','normal',messages,{jsonSchema:{name:'reply',value:{type:'string'}}});
      const quiet=await transport.createGenerationParameters(settings,'explicit-model','quiet',messages);
      const reasoning=await transport.createGenerationParameters({...settings,chat_completion_source:'openai'},'o1','normal',messages);
      const openai=await transport.createGenerationParameters({...settings,chat_completion_source:'openai',top_k_openai:40},'gpt-4o','normal',messages);
      const custom=await transport.createGenerationParameters({...settings,chat_completion_source:'custom',top_k_openai:40},'custom-model','normal',messages);
      let invalid='';try{await transport.createGenerationParameters(settings,'model','normal',null);}catch(error){invalid=error.message;}
      return {normal,quiet,reasoning,openai,custom,invalid,unchanged:before===JSON.stringify({settings,messages})};
    })()`);
    assert.equal(parameters.normal.generate_data.model,'explicit-model');assert.equal(parameters.normal.generate_data.messages.length,2);
    assert.equal(parameters.normal.generate_data._mycompanion_context_limit,4096);assert.equal(parameters.normal.generate_data.n,3);
    assert.equal(parameters.normal.stream,true);assert.equal(parameters.normal.canMultiSwipe,true);
    assert.equal(parameters.quiet.stream,false);assert.equal(parameters.quiet.canMultiSwipe,false);assert.equal(parameters.quiet.generate_data.n,undefined);
    assert.equal(parameters.reasoning.stream,false);assert.equal(parameters.reasoning.generate_data.max_completion_tokens,128);
    assert.equal(parameters.reasoning.generate_data.max_tokens,undefined);assert.equal(parameters.reasoning.generate_data.messages[0].role,'user');
    assert.equal(parameters.openai.generate_data.top_k,undefined);assert.equal(parameters.custom.generate_data.top_k,40);
    assert.equal(parameters.unchanged,true);assert.match(parameters.invalid,/array/);
    stages.push('public-generation-parameters-model-filtering-schema-multiswipe-and-immutable-input');

    const beforeBudget=requests.length;
    const budgets=await evaluate(`(async()=>{
      const messages=[{role:'user',content:'hello '.repeat(1000)}];
      const send=async limit=>{
        const settings={...structuredClone(transport.oai_settings),openai_max_context:limit,openai_max_tokens:128};
        const {generate_data}=await transport.createGenerationParameters(settings,'budget-model','quiet',messages);
        const response=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:transportCore.getRequestHeaders(),body:JSON.stringify(generate_data)});
        return {status:response.status,body:await response.json()};
      };
      return Promise.all([send(1024),send(4096)]);
    })()`);
    assert.equal(budgets[0].status,400);assert.match(budgets[0].body.error.message,/超出上下文/);assert.equal(budgets[1].status,200);
    assert.equal(requests.length,beforeBudget+1);assert.equal(requests.at(-1)._mycompanion_context_limit,undefined);assert.equal(requests.at(-1).model,'budget-model');
    stages.push('direct-extension-fetch-preserves-independent-request-context-budgets');
    return {stages,passed:true};
  } finally {model.closeAllConnections();await new Promise(resolve=>model.close(resolve));await evaluate(`delete window.transport;delete window.transportCore;delete window.transportAbort;delete window.transportResults;delete window.transportPending;`).catch(()=>{});}
}

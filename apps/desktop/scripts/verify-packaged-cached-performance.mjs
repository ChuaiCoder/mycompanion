// Public text only. Called from the existing EXE CDP/restart driver.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';

export function createPackagedCachedPerformance(report) {
  let storyId;
  const hardware={platform:platform(),osRelease:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),driverNode:process.version};
  async function ready(evaluate,id,select=false) {
    return evaluate(`(async()=>{
      const wait=async(predicate,label)=>{const until=Date.now()+25000;while(!await predicate()){if(Date.now()>until)throw new Error('Candidate performance ready deadline: '+label);await new Promise(done=>setTimeout(done,10));}};
      await wait(()=>document.querySelector('.service-state--online')&&document.getElementById('send_textarea'),'React service and composer');
      const core=await import('/plugin-runtime/compat-runtime.js'),host=await import('/plugin-runtime/desktop-host.js');await host.start();
      ${select?`const nav=[...document.querySelectorAll('nav button')].find(button=>button.textContent.trim().startsWith('故事'));if(!nav)throw new Error('Candidate performance story nav');nav.click();await wait(()=>document.querySelector('button[data-conversation-id="${id}"]'),'public fixture row');document.querySelector('button[data-conversation-id="${id}"]').click();`:''}
      await wait(()=>core.getContext().conversationId===${JSON.stringify(id)}&&core.getContext().chat.length===10000&&document.querySelectorAll('#chat > .mes').length===100&&!document.getElementById('send_textarea').disabled,'full native history and bounded actual DOM');
      const composer=document.getElementById('send_textarea');composer.focus();
      const textareaPrototype=HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(textareaPrototype,'value').set.call(composer,'PUBLIC_PERFORMANCE_READY');composer.dispatchEvent(new Event('input',{bubbles:true}));
      await wait(()=>document.activeElement===composer&&composer.value==='PUBLIC_PERFORMANCE_READY'&&!document.getElementById('send_but').disabled,'actual focused controlled input');
      Object.getOwnPropertyDescriptor(textareaPrototype,'value').set.call(composer,'');composer.dispatchEvent(new Event('input',{bubbles:true}));
      const first=document.querySelector('#chat > .mes'),last=document.querySelector('#chat > .last_mes');
      if(first.getAttribute('mesid')!=='9900'||last.getAttribute('mesid')!=='9999')throw new Error('Candidate absolute message window differs');
      return {hostMessageCount:core.getContext().chat.length,visibleMessageCount:document.querySelectorAll('#chat > .mes').length,firstAbsoluteIndex:Number(first.getAttribute('mesid')),lastAbsoluteIndex:Number(last.getAttribute('mesid')),actualComposerFocused:document.activeElement===composer};
    })()`);
  }
  return {
    async verify({phase,evaluate,origin,reload,sendCdp}) {
      const api=async(method,path,payload)=>{const response=await fetch(origin+path,{method,...(payload!==undefined?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})});assert(response.ok,'Candidate performance HTTP '+path+' status '+response.status);return response.json();};
      if(phase==='restart'){
        const result=await ready(evaluate,storyId,true);
        assert.equal((await api('GET','/api/conversations/'+storyId)).messages.length,10000);
        report.cachedPerformance.fullProcessRestart={passed:true,...result};report.stages.push('restart-packaged-public-10000-message-performance-fixture-and-focused-window');return;
      }
      const baseline=await api('GET','/api/conversations/'+report.independentRuns.find(run=>run.phase==='initial').conversationId);
      const created=await api('POST','/api/conversations',{characterId:baseline.characterId});storyId=created.id;
      // Construct the public extension snapshot from actual candidate facts.
      // There is no import of workspace RuntimeRepository or a private SQLite.
      const base={metadata:created.chatMetadata??{},messages:created.messages.map(message=>({name:message.role==='user'?'User':created.characterName,is_system:false,send_date:message.createdAt,extra:{},...message.extensionData,id:message.id,mes:message.content,is_user:message.role==='user',role:message.role,content:message.content,status:message.status}))};
      const timestamp=new Date().toISOString();
      const next={metadata:{...base.metadata,publicPerformanceFixture:true},messages:Array.from({length:10000},(_,index)=>({id:randomUUID(),mes:'Public packaged benchmark message '+index+' about a project-authored quiet room.',is_user:index%2===0,is_system:false,name:index%2===0?'User':'Independent fixture',role:index%2===0?'user':'assistant',status:'complete',send_date:timestamp,extra:{publicBenchmarkIndex:index}}))};
      const saved=await api('PUT','/api/conversations/'+created.id+'/extension-state',{branchId:created.activeBranchId,base,next});assert.equal(saved.messages.length,10000);
      await reload();await sendCdp('Page.bringToFront');await ready(evaluate,storyId,true);
      const runtime=await evaluate(`(()=>{let webglRenderer=null;try{const gl=document.createElement('canvas').getContext('webgl'),debug=gl?.getExtension('WEBGL_debug_renderer_info');if(debug)webglRenderer=gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);}catch{}return{userAgent:navigator.userAgent,electron:/Electron\\/([^ ]+)/.exec(navigator.userAgent)?.[1]??null,chromium:/Chrome\\/([^ ]+)/.exec(navigator.userAgent)?.[1]??null,webglRenderer,windowWidth:innerWidth,windowHeight:innerHeight,devicePixelRatio,visibility:document.visibilityState};})()`);
      const performance=report.cachedPerformance={passed:false,performancePassed:false,completeG06:false,workload:'actual candidate cached CDP reload/resume; public 10000 complete text messages; latest 100 real message DOM nodes; controlled composer focus/input marker',
        hardware:{...hardware,...runtime,softwareRenderingRequested:true,softwareRenderingEvidence:'Candidate launch flags --disable-gpu and --disable-renderer-backgrounding; WebGL renderer is separately observed and may be unavailable'},
        seedOrigin:'candidate POST /api/conversations then candidate PUT /api/conversations/:id/extension-state',messageCount:10000,visibleMessageCount:100,warmupMs:[],samplesMs:[],readySamples:[],targetP95Ms:2000,
        measurement:'driver monotonic wall time starts before Page.reload and includes CDP dispatch/load-event/Runtime.evaluate polling and real input/focus checks; conservative extra driver delay is included; no truncation or sample exclusion',
        comparison:'This ready predicate includes actual focus and controlled input. It differs from the historical source Electron predicate and is not a direct comparison with its p95.'};
      for(let attempt=0;attempt<35;attempt++){
        const started=globalThis.performance.now();await reload();const marker=await ready(evaluate,storyId);const elapsed=globalThis.performance.now()-started;
        (attempt<5?performance.warmupMs:performance.samplesMs).push(elapsed);performance.readySamples.push({warmup:attempt<5,...marker});
      }
      const sorted=[...performance.samplesMs].sort((a,b)=>a-b);
      performance.sampleCount=sorted.length;performance.p50Ms=(sorted[14]+sorted[15])/2;performance.p95Ms=sorted[Math.ceil(sorted.length*.95)-1];performance.maximumMs=sorted.at(-1);
      performance.performancePassed=performance.p95Ms<performance.targetP95Ms;report.performancePassed=performance.performancePassed;performance.passed=performance.performancePassed;
      report.stages.push('initial-packaged-public-10000-host-100-DOM-five-warmups-thirty-cached-reloads-focused-input');
      assert(performance.performancePassed,'Actual candidate cached interaction p95 '+performance.p95Ms+' ms exceeds '+performance.targetP95Ms+' ms; see complete retained samples');
    },
  };
}

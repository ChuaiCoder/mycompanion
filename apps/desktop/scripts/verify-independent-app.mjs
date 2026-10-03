import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { browserChecks } from './verify-plugin-primitives.mjs';

export async function verifyIndependentApp(window, report, { phase, reload = () => window.loadURL(window.webContents.getURL()), onboardingErrors = false }) {
    const evaluate = code => window.webContents.executeJavaScript(code);
    const wait = async expression => {
        const deadline = Date.now() + 20000;
        while (!await evaluate(expression)) {
            if (Date.now() > deadline) throw new Error('Independent UI wait timed out: ' + expression);
            await new Promise(done => setTimeout(done, 50));
        }
    };
    const stage = name => { report.stages.push(phase + '-' + name); console.log(report.stages.at(-1)); };
    await wait('Boolean(document.querySelector(".desktop-shell .service-state--online"))');
    const host = await evaluate(`(async () => ({
        health: await fetch('/api/health').then(r=>r.json()),
        topLevel: parent === window, node: typeof require, ownRoot: Boolean(document.querySelector('#root .desktop-shell')),
        tavernShell: Boolean(document.getElementById('mc-sidebar')),
    }))()`);
    assert.equal(host.health.service, 'mycompanion-local-service');
    assert.equal(host.topLevel, true); assert.equal(host.node, 'undefined');
    assert.equal(host.ownRoot, true); assert.equal(host.tavernShell, false);
    stage('own-react-document-and-local-service');

    const requests = [];
    const key = 'mc-independent-verification-key';
    const model = createServer(async (request, response) => {
        try {
            const authorized = request.headers.authorization === 'Bearer ' + key;
            let raw = ''; for await (const part of request) raw += part;
            const body = raw ? JSON.parse(raw) : null;
            requests.push({ path: request.url, authorized, body });
            if (!authorized) {
                response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid test credential' } }));
                return;
            }
            if (request.url.endsWith('/models')) {
                response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'independent-fixture' }] }));
            } else if (body.stream) {
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Independent model reply.' } }] }) + '\n\ndata: [DONE]\n\n');
            } else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
        } catch (error) { report.independentModelError = String(error); response.writeHead(500).end(); }
    });
    // The production credential scope includes the complete transport endpoint,
    // including its port. Rebind this controlled server at the original endpoint
    // after the full EXE restart so the persisted-key check tests the same scope.
    const fixturePort = phase === 'restart' ? report.independentProviderFixture?.port : 0;
    assert(Number.isInteger(fixturePort) && fixturePort >= 0 && fixturePort <= 65535
        && (phase !== 'restart' || fixturePort > 0), 'Restart requires the original controlled provider endpoint');
    await new Promise((done, reject) => {
        model.once('error', reject);
        model.listen(fixturePort, '127.0.0.1', () => { model.removeListener('error', reject); done(); });
    });
    if (phase === 'initial') report.independentProviderFixture = { host: '127.0.0.1', port: model.address().port,
        restartReusesEndpoint: true };
    try {
        let settings;
        if (phase === 'initial') {
            await evaluate(`(() => {
                document.querySelector('button[aria-label="设置"]').click();
            })()`);
            await wait('Boolean(document.querySelector("section[aria-labelledby=provider-title] form"))');
            await evaluate(`(() => {
                const form=document.querySelector('section[aria-labelledby="provider-title"] form');
                const write=(id,value) => {
                    const input=form.querySelector('#'+id);
                    if(!input) throw new Error('Provider field missing: '+id);
                    for(let details=input.closest('details');details;details=details.parentElement?.closest('details')) {
                        if(!details.open) details.querySelector(':scope > summary').click();
                    }
                    if(!input.getClientRects().length||input.disabled) throw new Error('Provider field unavailable: '+id);
                    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
                    input.dispatchEvent(new Event('input',{bubbles:true}));
                };
                write('provider-base-url','http://127.0.0.1:${model.address().port}/v1');
                write('provider-model','independent-fixture');
                write('provider-api-key',${JSON.stringify(onboardingErrors ? 'mc-invalid-fixture-key' : key)});
                form.querySelector('button[type="submit"]').click();
            })()`);
            if (onboardingErrors) {
                await wait(`document.querySelector('section[aria-labelledby="provider-title"] .notice--error')?.textContent.includes('服务拒绝了 API Key。')`);
                const failed = await evaluate(`(() => {
                    const form=document.querySelector('section[aria-labelledby="provider-title"] form');
                    const field=id=>form.querySelector('#'+id)?.value;
                    return {baseUrl:field('provider-base-url'),model:field('provider-model'),key:field('provider-api-key'),text:form.parentElement.textContent};
                })()`);
                assert.equal(failed.baseUrl, `http://127.0.0.1:${model.address().port}/v1`);
                assert.equal(failed.model, 'independent-fixture');
                assert.equal(failed.key, 'mc-invalid-fixture-key');
                assert(!failed.text.includes('设置已安全保存'));
                assert(!failed.text.includes('mc-invalid-fixture-key'));
                assert(!failed.text.includes('Invalid test credential'), 'Provider response text must not bypass the safe authentication guidance');
                assert(requests.some(request => !request.authorized && request.path.endsWith('/chat/completions')), 'The displayed authentication failure must come from a real rejected model request');
                const unsaved=await evaluate(`fetch('/api/settings/provider').then(response=>response.json())`);
                assert.equal(unsaved.hasApiKey,false,'Failed test must not persist invalid credentials');
                report.expectedOnboardingFailures = [{route:'/api/settings/provider/test',upstreamStatus:401,observedInUi:true,invalidCredentialPersisted:false}];
                await evaluate(`(() => {
                    const form=document.querySelector('section[aria-labelledby="provider-title"] form');
                    const input=form.querySelector('#provider-api-key');
                    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(key)});
                    input.dispatchEvent(new Event('input',{bubbles:true}));
                    form.querySelector('button[type="submit"]').click();
                })()`);
            }
            await wait(`Boolean(document.querySelector('section[aria-labelledby="provider-title"] .notice--success')?.textContent?.includes('设置已安全保存'))`);
            if (onboardingErrors) stage('new-user-invalid-key-shows-error-and-correction-reconnects');
            settings = await evaluate(`fetch('/api/settings/provider').then(r=>r.json())`);
            await evaluate(`[...document.querySelectorAll('.primary-nav button')].find(button=>button.querySelector('span')?.textContent==='角色库').click()`);
        } else {
            settings = await evaluate(`(async () => {
                const previous=await fetch('/api/settings/provider').then(r=>r.json());
                if(!previous.hasApiKey) throw new Error('Persisted key missing');
                const response = await fetch('/api/settings/provider', { method:'PUT', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({kind:'openai-compatible',baseUrl:'http://127.0.0.1:${model.address().port}/v1',model:'independent-fixture'}) });
                if(!response.ok) throw new Error(await response.text());
                return response.json();
            })()`);
            const tested = await evaluate(`(async()=>{
                const response=await fetch('/api/settings/provider/test',{method:'POST',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({kind:${JSON.stringify(settings.kind)},baseUrl:${JSON.stringify(settings.baseUrl)},model:${JSON.stringify(settings.model)}})});
                if(!response.ok)throw new Error(await response.text());return response.json();
            })()`);
            assert.equal(tested.ok, true, 'The persisted connection must still generate a valid model reply');
            assert.equal(tested.testedModel, 'independent-fixture');
            assert.equal(tested.capability, 'chat-completion');
        }
        assert.equal(settings.hasApiKey, true);
        assert(!JSON.stringify(settings).includes(key));
        assert(requests.some(request => request.path.endsWith('/chat/completions') && request.authorized && request.body?.model==='independent-fixture' && Array.isArray(request.body.messages)), 'Model connection must perform an authorized completion with the chosen model');
        stage(phase === 'initial' ? 'ui-provider-setup-encrypted-key-and-actual-model-connection'
            : 'encrypted-provider-key-and-actual-model-connection');
        if (phase === 'initial') {
            if (onboardingErrors) {
                await evaluate(`(() => {
                    const file=new File(['{"broken":'], 'broken.json', {type:'application/json'});
                    const transfer=new DataTransfer(); transfer.items.add(file);
                    const input=document.querySelector('input[type="file"]'); input.files=transfer.files;
                    input.dispatchEvent(new Event('change',{bubbles:true}));
                })()`);
                await wait(`Boolean(document.querySelector('.notice--error'))`);
                const rejected = await evaluate(`(async()=>({
                    text:document.querySelector('.notice--error').textContent,
                    cards:(await fetch('/api/characters').then(response=>response.json())).items.length,
                    confirmation:[...document.querySelectorAll('button')].some(button=>button.textContent==='确认导入'),
                }))()`);
                assert(rejected.text.length > 0);
                assert.equal(rejected.cards, 0);
                assert.equal(rejected.confirmation, false);
                report.expectedOnboardingFailures.push({action:'invalid-character-card-preview',observedInUi:true,storedCards:0});
                stage('new-user-invalid-card-shows-error-without-saving');
            }
            const card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
                name: 'Independent fixture', description: 'Project-owned character description.', personality: 'Calm', scenario: 'A quiet room',
                first_mes: 'Independent opening.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
                alternate_greetings: [], tags: [], creator: 'MyCompanion', character_version: '1', extensions: {},
            } };
            await evaluate(`(() => {
                const file = new File([${JSON.stringify(JSON.stringify(card))}], 'independent.json', {type:'application/json'});
                const transfer = new DataTransfer(); transfer.items.add(file);
                const input=document.querySelector('input[type="file"]'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
            })()`);
            await wait('[...document.querySelectorAll("button")].some(button=>button.textContent==="确认导入")');
            await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="确认导入").click()');
            await wait('Boolean(document.querySelector(".start-chat-button"))');
            await evaluate('document.querySelector(".start-chat-button").click()');
            await wait('document.querySelector(".chat-message-list")?.textContent.includes("Independent opening.")');
            stage('real-card-file-preview-import-and-start-chat');
            await evaluate(`(() => {
                const input=document.querySelector('textarea[aria-label="输入消息"]');
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Independent user message.');
                input.dispatchEvent(new Event('input',{bubbles:true}));
            })()`);
            await wait(`Boolean(document.querySelector('button[aria-label="发送消息"]')) && !document.querySelector('button[aria-label="发送消息"]').disabled`);
            await evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`);
            await wait('document.querySelector(".chat-message-list")?.textContent.includes("Independent model reply.")');
            assert(requests.some(request => request.body?.stream && request.authorized && JSON.stringify(request.body.messages).includes('Project-owned character description.')));
            stage('real-ui-send-stream-and-character-context');
        } else {
            await evaluate('[...document.querySelectorAll(".primary-nav button")].find(button=>button.querySelector("span")?.textContent==="故事").click()');
            await wait('Boolean(document.querySelector(".story-list-pane li button"))');
            const savedStory = report.independentRuns?.find(run => run.phase === 'initial')?.conversationId;
            await evaluate(savedStory ? `document.querySelector('button[data-conversation-id="${savedStory}"]').click()` : 'document.querySelector(".story-list-pane li button").click()');
            await wait('document.querySelector(".chat-message-list")?.textContent.includes("Independent model reply.")');
            stage('story-and-rendered-messages-survive-full-restart');
        }
        const data = await evaluate(`(async () => {
            const list=await fetch('/api/conversations').then(r=>r.json());
            const selected=${JSON.stringify(report.independentRuns?.find(run => run.phase === 'initial')?.conversationId ?? null)};
            return fetch('/api/conversations/'+(selected??list.items[0].id)).then(r=>r.json());
        })()`);
        assert.deepEqual(data.messages.map(message => message.content), ['Independent opening.', 'Independent user message.', 'Independent model reply.']);
        assert(data.messages.every(message => message.status === 'complete'));
        report.independentRuns ??= [];
        report.independentRuns.push({ phase, host, settings, conversationId: data.id, messages: data.messages, requests });
        stage('own-database-keeps-completed-messages');
        if (phase === 'initial') {
            // Reuse the project-authored fixture already covered by service
            // installation tests. This is an internal ZIP smoke test, not the
            // original helper or its required URL-install acceptance workflow.
            const fixtures = await readFile(new URL('../../local-service/src/test-helpers.ts', import.meta.url), 'utf8');
            const fixture = fixtures.match(/const sandboxExtensionZip = Buffer.from\(\s*"([A-Za-z0-9+/=]+)"/);
            assert(fixture, 'Own extension ZIP fixture missing');
            await evaluate(`(async () => {
                const bytes = Uint8Array.from(atob(${JSON.stringify(fixture[1])}), char => char.charCodeAt(0));
                const installed = await fetch('/api/code-plugins/install', { method:'POST', headers:{'Content-Type':'application/zip','x-plugin-filename':'sandbox-test.zip'}, body:bytes });
                if (!installed.ok) throw new Error(await installed.text());
                const enabled = await fetch('/api/code-plugins/sandbox-test/enabled', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({enabled:true}) });
                if (!enabled.ok) throw new Error(await enabled.text());
            })()`);
            await reload();
            await wait('Boolean(document.querySelector(".desktop-shell .service-state--online"))');
        }
        await evaluate('[...document.querySelectorAll(".primary-nav button")].find(button=>button.querySelector("span")?.textContent==="插件").click()');
        await wait(`import('/plugin-runtime/desktop-host.js').then(host => host.getStatuses()['sandbox-test'] === '扩展已运行')`);
        const primitiveCode = `(${browserChecks.toString()})()`;
        const primitives = await evaluate(primitiveCode);
        // browserChecks asserts each behavior; keep its completed stages in the
        // report without pinning their count to an older frozen candidate.
        report.independentPrimitives ??= [];
        report.independentPrimitives.push({ phase, ...primitives });
        stage('packaged-libraries-utilities-stream-and-browser-permissions');
        const popupResult = await evaluate(`(async () => {
          const { Handlebars } = await import('/lib.js');
          const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
          const html = Handlebars.compile('<h3>{{title}}</h3>{{#each items}}<p>{{this}}</p>{{/each}}')({ title: 'Packaged popup', items: ['<escaped>'] });
          const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', { animation: 'none', onOpen: dialog => dialog.okButton.click() });
          const value = await popup.show();
          return { value, escaped: html.includes('&lt;escaped&gt;'), disposed: !popup.dlg.isConnected && !Popup.util.isPopupOpen() };
        })()`);
        assert.deepEqual(popupResult, { value: 1, escaped: true, disposed: true });
        stage('packaged-handlebars-template-and-real-popup-completion');
        const settingsCode = `(async () => {
          const extensions = await import('/scripts/extensions.js');
          const script = await import('/script.js');
          if (${JSON.stringify(phase)} === 'initial') {
            extensions.extension_settings.packagedFixture = { survived: true };
            await script.saveSettings();
          }
          return extensions.extension_settings.packagedFixture;
        })()`;
        const extensionState = await evaluate(settingsCode);
        assert.deepEqual(extensionState, { survived: true });
        stage('extension-settings-persist-through-independent-service');
        const worldInfo = await evaluate(`(async () => {
          const wi=await import('/scripts/world-info.js');
          const {extension_settings}=await import('/plugin-runtime/settings.js');
          const script=await import('/script.js');
          if (${JSON.stringify(phase)} === 'initial') {
            await wi.saveWorldInfo('packaged-budget', {entries:{1:{
              ...structuredClone(wi.newWorldInfoEntryTemplate),uid:1,key:['budget-check'],
              content:'PACKAGED={{maxPrompt}}/{{maxContext}}/{{maxResponse}}/{{getglobalvar::packagedBudgetMarker}}',
              position:1,disable:false
            }}}, true);
            wi.selected_world_info.splice(0,wi.selected_world_info.length,'packaged-budget');
            (extension_settings.variables??={}).global??={};
            extension_settings.variables.global.packagedBudgetMarker='retained';
            await script.saveSettings();
          }
          const value=await wi.getWorldInfoPrompt(['budget-check'],4096,true,{});
          return {text:value.worldInfoAfter,selected:wi.selected_world_info.includes('packaged-budget')};
        })()`);
        assert.equal(worldInfo.text, `PACKAGED=${4096 - settings.maxTokens}/4096/${settings.maxTokens}/retained`);
        assert.equal(worldInfo.selected, true);
        stage(phase === 'initial' ? 'packaged-world-info-uses-live-budget-and-global-variable'
            : 'world-info-budget-and-global-variable-survive-full-restart');
        if (phase === 'initial') {
            // The fixed upstream oracle distinguishes the relative prompt's
            // residual syntax from IN_CHAT's WI scan and final bucket passes.
            // Browser snapshots defer evaluation; only actual provider traffic
            // proves accepted managed generation reached the native boundaries.
            try {
                const deferred = await evaluate(`(async () => {
                  const core=await import('/script.js');
                  const {getContext}=await import('/plugin-runtime/compat-runtime.js');
                  const host=await import('/plugin-runtime/desktop-host.js');
                  if(window.packagedMacroPhase) throw new Error('Macro phase fixture already active');
                  const context=getContext(),localPresent=Object.hasOwn(context.chatMetadata,'variables');
                  const local=context.chatMetadata.variables??={};
                  const globals=(context.extensionSettings.variables??={}).global??={};
                  const remember=(record,key)=>({present:Object.hasOwn(record,key),value:record[key]});
                  const localKeys=['outer','inner','packagedPhaseLocal'],globalKey='packagedPhaseGlobal';
                  const originalLocal=Object.fromEntries(localKeys.map(key=>[key,remember(local,key)]));
                  const originalGlobal=remember(globals,globalKey);
                  const promptKeys=['packaged-one-pass','packaged-phase-counter'];
                  const originalPrompts=Object.fromEntries(promptKeys.map(key=>[key,remember(core.extension_prompts,key)]));
                  const read=async path=>{const response=await fetch(path);if(!response.ok)throw new Error('Macro phase HTTP '+response.status);return response.json();};
                  const counters=()=>({local:getContext().chatMetadata.variables?.packagedPhaseLocal,global:getContext().extensionSettings.variables?.global?.packagedPhaseGlobal});
                  const canonical=async()=>({story:await read('/api/conversations/'+context.conversationId),settings:await read('/api/extensions/settings')});
                  const cleanup=async()=>{
                    for(const key of promptKeys){const original=originalPrompts[key];if(original.present)core.extension_prompts[key]=original.value;else delete core.extension_prompts[key];}
                    const current=getContext().chatMetadata;
                    for(const key of localKeys){const original=originalLocal[key];if(original.present)current.variables[key]=original.value;else delete current.variables[key];}
                    if(!localPresent&&Object.keys(current.variables).length===0)delete current.variables;
                    const currentGlobals=getContext().extensionSettings.variables.global;
                    if(originalGlobal.present)currentGlobals[globalKey]=originalGlobal.value;else delete currentGlobals[globalKey];
                    await core.saveMetadata();await core.saveSettings();delete window.packagedMacroPhase;
                  };
                  window.packagedMacroPhase={core,host,getContext,counters,canonical,cleanup};
                  local.outer='{{getvar::inner}}';local.inner='SECOND';local.packagedPhaseLocal=0;globals[globalKey]=0;
                  await core.saveMetadata();await core.saveSettings();
                  core.setExtensionPrompt(promptKeys[0],'{{getvar::outer}}',0,0,true,0);
                  core.setExtensionPrompt(promptKeys[1],'PACKAGED_PHASE_COUNTER={{incvar::packagedPhaseLocal}}/{{incglobalvar::packagedPhaseGlobal}}',1,0,true,0);
                  const prompts=await host.prepareExtensionPrompts();
                  window.packagedMacroPhase.prompts=prompts;
                  window.packagedMacroPhase.beforePreview=await canonical();
                  window.packagedMacroPhase.beforeChat=structuredClone(getContext().chat);
                  return {prompts:prompts.filter(item=>promptKeys.includes(item.key)).map(({key,value,macrosResolved})=>({key,value,macrosResolved})),
                    counters:counters(),stored:{local:window.packagedMacroPhase.beforePreview.story.chatMetadata.variables.packagedPhaseLocal,
                      global:window.packagedMacroPhase.beforePreview.settings.extensionSettings.variables.global.packagedPhaseGlobal}};
                })()`);
                assert.deepEqual(deferred, {prompts:[
                    {key:'packaged-one-pass',value:'{{getvar::outer}}',macrosResolved:false},
                    {key:'packaged-phase-counter',value:'PACKAGED_PHASE_COUNTER={{incvar::packagedPhaseLocal}}/{{incglobalvar::packagedPhaseGlobal}}',macrosResolved:false},
                ],counters:{local:0,global:0},stored:{local:0,global:0}});
                stage('packaged-extension-prompt-snapshot-defers-native-macro-passes');

                const beforePreviewRequests=requests.length;
                const preview = await evaluate(`(async () => {
                  const state=window.packagedMacroPhase;
                  const response=await fetch('/api/conversations/'+state.getContext().conversationId+'/prompt-preview',{
                    method:'POST',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({draft:'PACKAGED_PHASE_PREVIEW',extensionPrompts:state.prompts})
                  });
                  if(!response.ok)throw new Error('Macro phase preview HTTP '+response.status);
                  const value=await response.json(),after=await state.canonical();
                  return {relativeResidual:value.messages.some(message=>message.content==='{{getvar::inner}}'),
                    counterMessages:value.messages.filter(message=>message.content.includes('PACKAGED_PHASE_COUNTER=')).map(message=>message.content),
                    before:state.beforePreview,after,counters:state.counters(),
                    chatUnchanged:JSON.stringify(state.getContext().chat)===JSON.stringify(state.beforeChat)};
                })()`);
                assert.equal(preview.relativeResidual,true);
                assert.deepEqual(preview.counterMessages,['PACKAGED_PHASE_COUNTER=2/2']);
                assert.deepEqual(preview.after,preview.before,'Preview must preserve the complete canonical story and extension settings');
                assert.deepEqual(preview.counters,{local:0,global:0});
                assert.equal(preview.chatUnchanged,true);
                assert.equal(requests.length,beforePreviewRequests,'Prompt preview must not reach the provider');
                stage('packaged-native-preview-keeps-database-browser-vars-and-provider-isolated');

                const accepted=[];
                for (const [scan,expected] of [[true,2],[false,3]]) {
                    const beforeRequests=requests.length;
                    const result=await evaluate(`(async () => {
                      const state=window.packagedMacroPhase;
                      state.core.setExtensionPrompt('packaged-phase-counter','PACKAGED_PHASE_COUNTER={{incvar::packagedPhaseLocal}}/{{incglobalvar::packagedPhaseGlobal}}',1,0,${scan},0);
                      await state.core.generateQuietPrompt({quietPrompt:'PACKAGED_PHASE_QUIET_${scan ? 'SCAN' : 'NO_SCAN'}'});
                      const after=await state.canonical();
                      return {counters:state.counters(),stored:{local:after.story.chatMetadata.variables.packagedPhaseLocal,
                        global:after.settings.extensionSettings.variables.global.packagedPhaseGlobal},
                        databaseMessagesUnchanged:JSON.stringify(after.story.messages)===JSON.stringify(state.beforePreview.story.messages),
                        browserChatUnchanged:JSON.stringify(state.getContext().chat)===JSON.stringify(state.beforeChat)};
                    })()`);
                    const actual=requests.slice(beforeRequests);
                    assert.equal(actual.length,1,'Managed quiet must send exactly one actual provider request');
                    assert.equal(actual[0].authorized,true);
                    assert(actual[0].path.endsWith('/chat/completions'));
                    assert.equal(actual[0].body.model,'independent-fixture');
                    assert(actual[0].body.messages.some(message=>message.content===`PACKAGED_PHASE_QUIET_${scan ? 'SCAN' : 'NO_SCAN'}`));
                    assert(actual[0].body.messages.some(message=>message.content==='{{getvar::inner}}'),'Relative prompt keeps its independent single-pass residual');
                    assert.deepEqual(actual[0].body.messages.filter(message=>message.content.includes('PACKAGED_PHASE_COUNTER=')).map(message=>message.content),[`PACKAGED_PHASE_COUNTER=${expected}/${expected}`]);
                    assert.deepEqual(result,{counters:{local:expected,global:expected},stored:{local:expected,global:expected},databaseMessagesUnchanged:true,browserChatUnchanged:true});
                    accepted.push({scan,actualProviderRequests:actual.length,local:expected,global:expected,quietMessagesUnchanged:true});
                    stage(scan?'packaged-managed-quiet-wire-and-canonical-vars-prove-wi-and-in-chat-passes'
                        :'packaged-managed-quiet-without-scan-increments-once-from-two-to-three');
                }
                report.independentMacroPhases={rawSnapshot:true,relativeResidual:'{{getvar::inner}}',preview:{local:0,global:0,providerRequests:0,canonicalUnchanged:true},accepted};
            } finally {
                await evaluate(`(async()=>{await window.packagedMacroPhase?.cleanup();})()`);
            }
        }
    } finally { model.closeAllConnections(); await new Promise(done => model.close(done)); }
}

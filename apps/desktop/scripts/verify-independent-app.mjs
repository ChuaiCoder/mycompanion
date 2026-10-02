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
    await new Promise(done => model.listen(0, '127.0.0.1', done));
    try {
        let settings;
        if (phase === 'initial') {
            await evaluate(`(() => {
                document.querySelector('button[aria-label="设置"]').click();
            })()`);
            await wait('Boolean(document.querySelector("section[aria-labelledby=provider-title] form"))');
            await evaluate(`(() => {
                const form=document.querySelector('section[aria-labelledby="provider-title"] form');
                const write=(name,value) => {
                    const label=[...form.querySelectorAll('label')].find(item=>item.querySelector('span')?.textContent===name);
                    if(!label) throw new Error('Provider field missing: '+name);
                    const input=label.querySelector('input');
                    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
                    input.dispatchEvent(new Event('input',{bubbles:true}));
                };
                write('Base URL','http://127.0.0.1:${model.address().port}/v1');
                write('模型名称','independent-fixture');
                write('API Key',${JSON.stringify(onboardingErrors ? 'mc-invalid-fixture-key' : key)});
                [...form.querySelectorAll('button')].find(button=>button.textContent==='保存并测试连接').click();
            })()`);
            if (onboardingErrors) {
                await wait(`document.querySelector('section[aria-labelledby="provider-title"]')?.textContent.includes('Invalid test credential')`);
                const failed = await evaluate(`(() => {
                    const form=document.querySelector('section[aria-labelledby="provider-title"] form');
                    const field=name=>[...form.querySelectorAll('label')].find(label=>label.querySelector('span')?.textContent===name)?.querySelector('input')?.value;
                    return {baseUrl:field('Base URL'),model:field('模型名称'),key:field('API Key'),text:form.parentElement.textContent};
                })()`);
                assert.equal(failed.baseUrl, `http://127.0.0.1:${model.address().port}/v1`);
                assert.equal(failed.model, 'independent-fixture');
                assert.equal(failed.key, '');
                assert(!failed.text.includes('连接成功'));
                assert(!failed.text.includes('mc-invalid-fixture-key'));
                report.expectedOnboardingFailures = [{route:'/api/settings/provider/test',status:401,observedInUi:true}];
                await evaluate(`(() => {
                    const form=document.querySelector('section[aria-labelledby="provider-title"] form');
                    const label=[...form.querySelectorAll('label')].find(item=>item.querySelector('span')?.textContent==='API Key');
                    const input=label.querySelector('input');
                    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(key)});
                    input.dispatchEvent(new Event('input',{bubbles:true}));
                    [...form.querySelectorAll('button')].find(button=>button.textContent==='保存并测试连接').click();
                })()`);
            }
            await wait(`Boolean(document.querySelector('section[aria-labelledby="provider-title"] .notice')?.textContent?.includes('连接成功'))`);
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
            await evaluate(`(async()=>{const r=await fetch('/api/settings/provider/test',{method:'POST'});if(!r.ok)throw new Error(await r.text());})()`);
        }
        assert.equal(settings.hasApiKey, true);
        assert(!JSON.stringify(settings).includes(key));
        assert(requests.some(request => request.path.endsWith('/models') && request.authorized));
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
            await evaluate('document.querySelector(".story-list-pane li button").click()');
            await wait('document.querySelector(".chat-message-list")?.textContent.includes("Independent model reply.")');
            stage('story-and-rendered-messages-survive-full-restart');
        }
        const data = await evaluate(`(async () => {
            const list=await fetch('/api/conversations').then(r=>r.json());
            return fetch('/api/conversations/'+list.items[0].id).then(r=>r.json());
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
            const onePass = await evaluate(`(async () => {
              const core=await import('/script.js');
              const host=await import('/plugin-runtime/desktop-host.js');
              core.chat_metadata.variables??={};
              core.chat_metadata.variables.outer='{{getvar::inner}}';
              core.chat_metadata.variables.inner='SECOND';
              await core.saveMetadata();
              core.setExtensionPrompt('packaged-one-pass','{{getvar::outer}}',0,0,true,0);
              try {
                const prompt=(await host.prepareExtensionPrompts()).find(item=>item.key==='packaged-one-pass');
                const list=await fetch('/api/conversations').then(r=>r.json());
                const preview=await fetch('/api/conversations/'+list.items[0].id+'/prompt-preview',{
                  method:'POST',headers:{'Content-Type':'application/json'},
                  body:JSON.stringify({draft:'Continue',extensionPrompts:await host.prepareExtensionPrompts()})
                }).then(r=>r.json());
                return {snapshot:prompt?.value,resolved:prompt?.macrosResolved,
                  sent:preview.messages.some(message=>message.content==='{{getvar::inner}}')};
              } finally {
                delete core.extension_prompts['packaged-one-pass'];
                delete core.chat_metadata.variables.outer;
                delete core.chat_metadata.variables.inner;
                await core.saveMetadata();
              }
            })()`);
            assert.deepEqual(onePass,{snapshot:'{{getvar::inner}}',resolved:true,sent:true});
            stage('packaged-extension-prompt-snapshot-uses-one-macro-pass');
        }
    } finally { model.closeAllConnections(); await new Promise(done => model.close(done)); }
}

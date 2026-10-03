import assert from 'node:assert/strict';

const text = body => JSON.stringify(body.messages);

/** Exercises original Slash commands in the actual packaged Chromium document. */
export async function verifyPackagedSlashInjections({ view, send, importBook, setScenario, requests, phase, record }) {
  const worlds = await view('return [...wi.selected_world_info];');
  const slash = body => view(`const {executeSlashCommandsWithOptions}=await import('/scripts/slash-commands.js');const result=await executeSlashCommandsWithOptions(${JSON.stringify(body)},{handleParserErrors:false,handleExecutionErrors:false});check(!result.isAborted&&!result.isError,'Original injection command completes');return result.pipe;`);
  const list = async () => JSON.parse(await slash('/listinjects return=object'));
  const flush = () => view("await (await import('/plugin-runtime/chat.js')).flushChatSaves();");
  try {
    for (const command of [
      '/inject id=e01_before position=before PACKAGED_INJECT_BEFORE',
      '/inject id=e01_after position=after PACKAGED_INJECT_AFTER',
      '/inject id=e01_chat position=chat depth=1 role=assistant PACKAGED_INJECT_CHAT',
      '/inject id=e01_hidden position=none scan=true PACKAGED_SCAN_TRIGGER',
      '/inject id=e01_pass position=chat depth=0 filter={: /pass true :} PACKAGED_FILTER_PASS',
      '/inject id=e01_fail position=chat depth=0 filter={: /pass false :} PACKAGED_FILTER_FAIL',
    ]) await slash(command);
    const configured = await list();
    assert.equal(configured.e01_before.value, 'PACKAGED_INJECT_BEFORE');
    assert.equal(configured.e01_chat.depth, 1); assert.equal(configured.e01_chat.role, 2);
    assert.equal(configured.e01_hidden.scan, true); assert.equal(typeof configured.e01_pass.filter, 'string');
    await view(`const {executeSlashCommandsWithOptions}=await import('/scripts/slash-commands.js'),{Popup}=await import('/scripts/popup.js');const pending=executeSlashCommandsWithOptions('/listinjects',{handleParserErrors:false,handleExecutionErrors:false});await wait(()=>Popup.util.popups.some(p=>p.dlg.open&&p.content.textContent.includes('PACKAGED_INJECT_BEFORE')),'Original listinjects default Popup');const popup=Popup.util.popups.find(p=>p.dlg.open&&p.content.textContent.includes('PACKAGED_INJECT_BEFORE'));check(popup.dlg.matches(':modal'),'Original injection listing is an actual modal');popup.okButton.click();const result=await pending;check(!result.isAborted&&!result.isError&&!popup.dlg.isConnected,'Original listing completes and disposes');`);
    await importBook('Packaged injection scan', { entries: { 0: { uid: 0, comment: 'Public injection scan', key: ['PACKAGED_SCAN_TRIGGER'], keysecondary: [], content: 'PACKAGED_SCANNED_INJECT', constant: false, disable: false, order: 100, position: 0, selective: true, selectiveLogic: 0, probability: 100, useProbability: false } } });
    await view("const worlds=document.getElementById('world_info');for(const option of worlds.options)option.selected=option.textContent==='Packaged injection scan';worlds.dispatchEvent(new Event('change',{bubbles:true}));await (await import('/plugin-runtime/settings.js')).saveSettings();");
    const actual = (await send('Public injection placement probe'))[0].body;
    for (const marker of ['PACKAGED_INJECT_BEFORE', 'PACKAGED_INJECT_AFTER', 'PACKAGED_INJECT_CHAT', 'PACKAGED_FILTER_PASS', 'PACKAGED_SCANNED_INJECT']) assert(text(actual).includes(marker), marker);
    for (const marker of ['PACKAGED_FILTER_FAIL', 'PACKAGED_SCAN_TRIGGER']) assert(!text(actual).includes(marker), marker);
    assert(actual.messages.some(message => message.role === 'assistant' && String(message.content).includes('PACKAGED_INJECT_CHAT')));
    await slash('/flushinject e01_after');
    const partlyFlushed = await list(); assert(!Object.hasOwn(partlyFlushed, 'e01_after')); assert(Object.hasOwn(partlyFlushed, 'e01_before'));
    await slash('/flushinjects'); assert.deepEqual(await list(), {});
    record(phase, 'original-inject-list-default-Popup-position-role-hidden-WI-filter-and-flush-alias');

    await slash('/inject id=e01_once ephemeral=true position=chat depth=0 PACKAGED_ONCE_INJECT');
    const previewStart = requests.length;
    await view("await core.Generate('normal',{},true);");
    assert.equal(requests.length, previewStart, 'Injection preview does not request the provider');
    assert(Object.hasOwn(await list(), 'e01_once'), 'Preview does not consume an ephemeral injection');
    const first = (await send('Public first once injection probe'))[0].body;
    assert(text(first).includes('PACKAGED_ONCE_INJECT'));
    await view("await wait(()=>!core.getContext().chatMetadata.script_injects?.e01_once,'Original ephemeral cleanup after accepted generation');");
    const second = (await send('Public second injection probe'))[0].body;
    assert(!text(second).includes('PACKAGED_ONCE_INJECT'));
    await slash('/inject id=e01_stopped ephemeral=true position=chat depth=0 PACKAGED_STOP_INJECT');
    const stopStart = requests.length; setScenario('continue-stop');
    await view("edit(document.getElementById('send_textarea'),'Public stopped injection probe');document.getElementById('send_but').click();await wait(()=>core.getContext().nativeGenerating&&core.getContext().chat.at(-1)?.mes.includes(' partial text'),'Original injection active streaming request');const {executeSlashCommandsWithOptions}=await import('/scripts/slash-commands.js');check((await executeSlashCommandsWithOptions('/generate-stop',{handleParserErrors:false,handleExecutionErrors:false})).pipe==='true','Original stop completes its own pipe');await wait(()=>!core.getContext().nativeGenerating&&!core.getContext().chatMetadata.script_injects?.e01_stopped,'Original ephemeral cleanup after stopped generation');");
    assert(text(requests.slice(stopStart).find(item => item.body.stream).body).includes('PACKAGED_STOP_INJECT'));
    await flush(); assert.deepEqual(await list(), {});
    record(phase, 'original-ephemeral-injection-preview-retains-once-completion-and-stop-cleanup');
    await slash('/inject id=e01_persist position=before filter={: /pass true :} PACKAGED_INJECT_PERSIST');
    await flush(); assert.equal((await list()).e01_persist.value, 'PACKAGED_INJECT_PERSIST');
    record(phase, 'original-injection-metadata-and-filter-saved-for-full-EXE-restart');
  } finally {
    await view(`const selected=new Set(${JSON.stringify(worlds)}),worlds=document.getElementById('world_info');for(const option of worlds.options)option.selected=selected.has(option.textContent);worlds.dispatchEvent(new Event('change',{bubbles:true}));await (await import('/plugin-runtime/settings.js')).saveSettings();`);
  }
}

export async function verifyPackagedSlashInjectionsRestart({ view, phase, record }) {
  await view("const {executeSlashCommandsWithOptions}=await import('/scripts/slash-commands.js');await wait(()=>core.getContext().extensionPrompts&&Object.values(core.getContext().extensionPrompts).some(prompt=>prompt.value==='PACKAGED_INJECT_PERSIST'),'Original saved injection restored into live prompts');const result=await executeSlashCommandsWithOptions('/listinjects return=object',{handleParserErrors:false,handleExecutionErrors:false});const list=JSON.parse(result.pipe);check(list.e01_persist.value==='PACKAGED_INJECT_PERSIST'&&typeof list.e01_persist.filter==='string'&&!list.e01_once&&!list.e01_stopped,'Original injection metadata and raw filter restored without consumed once injections');");
  record(phase, 'original-injection-metadata-filter-and-live-prompts-survive-full-EXE-restart');
}

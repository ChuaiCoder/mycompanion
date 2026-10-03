import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "acorn";
import { createSlashFixture } from "./slash-runtime-fixture.js";

// jsdom belongs to the renderer workspace. Actual product DOMPurify, jQuery,
// Popup and Slash sources run together; only unavailable dialog/animation
// platform methods are supplied here. Chromium top-layer validation is separate.
const { JSDOM } = createRequire(new URL("../../renderer/package.json", import.meta.url))("jsdom");
const options = { handleParserErrors: false, handleExecutionErrors: false };
async function fixture(root?: string) {
  const dom = new JSDOM('<!doctype html><button id="focus">Focus</button><textarea id="send_textarea"></textarea><button id="send_but">Send</button>', { url: 'http://localhost/' });
  const window = dom.window;
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.Element.prototype.getAnimations = () => [];
  const h = await createSlashFixture(root, undefined, { domWindow: window, generationControls: true });
  return { ...h, window, document: window.document, run: (text: string, more = {}) => h.api.executeSlashCommandsWithOptions(text, { ...options, ...more }),
    dispose: () => { h.close(); window.close(); } };
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('DOM popup deadline');
}
const active = (h: Awaited<ReturnType<typeof fixture>>) => h.api.Popup.util.popups.filter((popup: any) => popup.dlg.open).at(-1);
async function popup(h: Awaited<ReturnType<typeof fixture>>) {
  await until(() => Boolean(active(h))); return active(h);
}

it("runs original input parameters and lexical success/cancel closures against actual DOM", async () => {
  const h = await fixture();
  try {
    const focus = h.document.getElementById('focus'); focus.focus();
    const result = h.run('/let key=who scoped | /input default=seed rows=3 wide=on large=on placeholder=hint tooltip=tip okButton=Choose onSuccess={: /setvar key=success {{var::who}} :} onCancel={: /setvar key=cancel forbidden :} <b>Question</b><img src=x onerror="bad()">');
    const shown = await popup(h);
    expect(shown.mainInput.value).toBe('seed'); expect(shown.mainInput.rows).toBe(3);
    expect(shown.mainInput.placeholder).toBe('hint'); expect(shown.mainInput.title).toBe('tip');
    expect(shown.okButton.textContent).toBe('Choose');
    expect(shown.dlg.classList.contains('wide_dialogue_popup')).toBe(true);
    expect(shown.dlg.classList.contains('large_dialogue_popup')).toBe(true);
    expect(shown.content.querySelector('b').textContent).toBe('Question');
    expect(shown.content.querySelector('img').hasAttribute('onerror')).toBe(false);
    expect(h.document.activeElement).toBe(shown.mainInput);
    shown.mainInput.value = '  entered  '; shown.okButton.click();
    expect(await result).toMatchObject({ pipe: '  entered  ', isAborted: false, isError: false });
    expect(h.context.chatMetadata.variables).toMatchObject({ success: 'scoped' });
    expect(h.context.chatMetadata.variables.cancel).toBeUndefined();
    expect(shown.dlg.isConnected).toBe(false); expect(h.document.activeElement).toBe(focus);
    const cancelled = h.run('/let key=who cancel-scope | /prompt rows=invalid onCancel={: /setvar key=cancel {{var::who}} :} Question');
    const second = await popup(h); expect(second.mainInput.rows).toBe(4); second.cancelButton.click();
    expect(await cancelled).toMatchObject({ pipe: '', isAborted: false });
    expect(h.context.chatMetadata.variables.cancel).toBe('cancel-scope');
    expect(h.context.chat).toEqual([]);
    expect(h.traces.some((trace: any[]) => ['chatSave', 'tokenCount', 'generationStop'].includes(trace[0]))).toBe(false);
  } finally { h.dispose(); }
});

it("distinguishes empty input success, keyboard submit, ordinary Escape and invalid closure errors", async () => {
  const h = await fixture();
  try {
    const empty = h.run('/input rows=2 onSuccess={: /incvar success :} onCancel={: /incvar cancel :} Question');
    const shown = await popup(h);
    shown.mainInput.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(shown.dlg.open).toBe(true);
    shown.mainInput.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    expect((await empty).pipe).toBe(''); expect(h.context.chatMetadata.variables.success).toBe(1);
    const escaped = h.run('/input onCancel={: /incvar cancel :} Question');
    (await popup(h)).dlg.dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
    expect((await escaped).pipe).toBe(''); expect(h.context.chatMetadata.variables.cancel).toBe(1);
    const invalid = h.run('/input onSuccess=invalid Question');
    const error = invalid.catch((reason: any) => reason);
    (await popup(h)).okButton.click();
    expect(await error).toMatchObject({ message: expect.stringContaining("'onSuccess' must be a closure") });
    expect(h.api.Popup.util.popups).toHaveLength(0); expect(h.timers.size).toBe(0);
  } finally { h.dispose(); }
});

it("preserves popup text/result and actual options while sanitizing only the displayed HTML", async () => {
  const h = await fixture();
  try {
    const raw = '<b>Body</b><img src=x onerror="bad()">';
    const result = h.run('/popup header="<i>Header</i>" wide=true wider=true large=true transparent=true scroll=false tooltip=tip okButton=Yes cancelButton=No ' + raw);
    const shown = await popup(h);
    expect(shown.content.querySelector('h3 i').textContent).toBe('Header');
    expect(shown.content.querySelector('img').hasAttribute('onerror')).toBe(false);
    expect(shown.content.title).toBe('tip'); expect(shown.cancelButton.textContent).toBe('No');
    for (const name of ['wide', 'wider', 'large', 'transparent']) expect(shown.dlg.classList.contains(name + '_dialogue_popup')).toBe(true);
    expect(shown.dlg.classList.contains('vertical_scrolling_dialogue_popup')).toBe(false);
    shown.cancelButton.click(); expect((await result).pipe).toBe(raw);
    for (const [action, expected] of [['ok', '1'], ['cancel', '0'], ['escape', '']]) {
      const pending = h.run('/popup result=true cancelButton=No Body'); const modal = await popup(h);
      if (action === 'escape') modal.dlg.dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
      else (action === 'ok' ? modal.okButton : modal.cancelButton).click();
      expect(await pending).toMatchObject({ pipe: expected, isAborted: false });
    }
  } finally { h.dispose(); }
});

it("executes buttons on real DOM with literal labels, icons, selection order and invalid input behavior", async () => {
  const h = await fixture();
  try {
    const single = h.run('/buttons labels=[{"text":"<b>A</b>","icon":"fa-save","tooltip":"Save"},"B"] Pick');
    const shown = await popup(h), choice = shown.content.querySelector('[data-result="2"]');
    expect(choice.textContent).toBe('<b>A</b>'); expect(choice.querySelector('b')).toBeNull();
    expect(choice.querySelector('i').classList.contains('fa-save')).toBe(true); expect(choice.title).toBe('Save');
    expect(h.window.getComputedStyle(choice).display).toBe('flex');
    const scrolling = h.window.getComputedStyle(shown.content.querySelector('.scrollable-buttons-container'));
    expect(Number.parseFloat(scrolling.maxHeight)).toBe(h.window.innerHeight / 2); expect(scrolling.overflowY).toBe('auto');
    choice.click(); expect((await single).pipe).toBe('<b>A</b>');
    const multiple = h.run('/buttons multiple=true labels=["A","B","C"] Pick');
    const modal = await popup(h), buttons = modal.content.querySelectorAll('[data-toggle-value]');
    buttons[1].click(); buttons[0].click(); buttons[2].click(); buttons[2].click(); modal.okButton.click();
    expect(Array.from(buttons).map((button: any) => button.classList.contains('toggled'))).toEqual([true, true, false]);
    expect((await multiple).pipe).toBe('["B","A"]');
    const cancelled = h.run('/buttons multiple=true labels=["A","B"] Pick');
    (await popup(h)).dlg.dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
    expect((await cancelled).pipe).toBe('[]');
    for (const labels of ['[]', 'null', '[null]', '[{"text":""}]', 'invalid']) expect((await h.run('/buttons labels=' + labels + ' Pick')).pipe).toBe('');
    expect(h.api.Popup.util.popups).toHaveLength(0);
  } finally { h.dispose(); }
});

it.each(['controller', 'stop', 'story', 'branch', 'pagehide'])("removes a pending input and prevents old handlers/pipeline writes on %s", async trigger => {
  const h = await fixture();
  try {
    const controller = new h.api.SlashCommandAbortController();
    const pending = h.run('/input onSuccess={: /setvar key=late forbidden :} onCancel={: /setvar key=late forbidden :} Question | /setvar key=late forbidden', { abortController: controller });
    const shown = await popup(h);
    if (trigger === 'controller') controller.abort('cancelled', true);
    if (trigger === 'stop') h.api.stopGeneration();
    if (trigger === 'story') await h.api.applyHostContext({ conversationId: 'story-b', chatMetadata: { variables: {} } });
    if (trigger === 'branch') await h.api.applyHostContext({ branchId: 'branch-b' });
    if (trigger === 'pagehide') h.pagehide();
    expect(await pending).toMatchObject({ isAborted: true, isError: false });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(shown.dlg.isConnected).toBe(false); expect(h.api.Popup.util.popups).toHaveLength(0);
    expect(h.context.chatMetadata.variables.late).toBeUndefined();
    expect(controller.listeners.abort ?? []).toHaveLength(0); expect(h.timers.size).toBe(0);
  } finally { h.dispose(); }
});

it("keeps concurrent invocation bindings and an unrelated extension popup independent", async () => {
  const h = await fixture();
  try {
    const unrelated = new h.api.Popup('Extension popup', h.api.POPUP_TYPE.TEXT, '', { animation: 'none' });
    const external = unrelated.show();
    const firstController = new h.api.SlashCommandAbortController(), secondController = new h.api.SlashCommandAbortController();
    const first = h.run('/let key=who first | /input onSuccess={: /setvar key=first {{var::who}} :} First', { abortController: firstController });
    const second = h.run('/let key=who second | /input onSuccess={: /setvar key=second {{var::who}} :} Second', { abortController: secondController });
    await until(() => h.api.Popup.util.popups.filter((item: any) => item.dlg.open).length === 3);
    const firstPopup = h.api.Popup.util.popups.find((item: any) => item.content.textContent === 'First');
    const secondPopup = h.api.Popup.util.popups.find((item: any) => item.content.textContent === 'Second');
    firstController.abort('first only', true);
    expect(await first).toMatchObject({ isAborted: true });
    expect(secondPopup.dlg.open).toBe(true); expect(unrelated.dlg.open).toBe(true);
    secondPopup.mainInput.value = 'chosen'; secondPopup.okButton.click();
    expect(await second).toMatchObject({ pipe: 'chosen', isAborted: false });
    expect(h.context.chatMetadata.variables.first).toBeUndefined(); expect(h.context.chatMetadata.variables.second).toBe('second');
    unrelated.okButton.click(); expect(await external).toBe(1);
    expect(h.api.Popup.util.popups).toHaveLength(0); expect(h.timers.size).toBe(0);
  } finally { h.dispose(); }
});

it.each(['/popup result=true Body', '/buttons labels=["A","B"] Pick'])("cancels the original %s dialog without returning a user choice or leaving listeners", async command => {
  const h = await fixture();
  try {
    const controller = new h.api.SlashCommandAbortController();
    const pending = h.run(command + ' | /setvar key=late forbidden', { abortController: controller });
    const shown = await popup(h); controller.abort('cancelled', true);
    expect(await pending).toMatchObject({ isAborted: true, isError: false });
    expect(shown.dlg.isConnected).toBe(false); expect(h.api.Popup.util.popups).toHaveLength(0);
    expect(h.context.chatMetadata.variables.late).toBeUndefined(); expect(controller.listeners.abort ?? []).toHaveLength(0);
  } finally { h.dispose(); }
});

it("preserves common extension Popup guards, awaited hooks, result controls and empty input helper behavior", async () => {
  const h = await fixture();
  try {
    let attempts = 0, closed = false;
    const shared = new h.api.Popup('<button class="result-control" data-result="1001">Custom</button>', h.api.POPUP_TYPE.CONFIRM, '', {
      animation: 'none', onClosing: async () => ++attempts > 1, onClose: async () => { await Promise.resolve(); closed = true; },
    });
    const shown = shared.show();
    await shared.completeAffirmative(); expect(shared.dlg.open).toBe(true); expect(closed).toBe(false);
    shared.content.querySelector('[data-result="1001"]').click();
    expect(await shown).toBe(1001); expect(closed).toBe(true); expect(shared.dlg.isConnected).toBe(false);
    const empty = h.api.Popup.show.input('Header', 'Text'); (await popup(h)).okButton.click(); expect(await empty).toBe('');
    const negative = h.api.Popup.show.input('Header', 'Text'); (await popup(h)).cancelButton.click(); expect(await negative).toBeNull();
  } finally { h.dispose(); }
});

it("cleans cancellation before the original input delay and cancels a held success closure without later writes", async () => {
  const h = await fixture();
  try {
    const early = new h.api.SlashCommandAbortController();
    const pending = h.run('/input onCancel={: /setvar key=late forbidden :} Early', { abortController: early }); early.abort('early', true);
    expect(await pending).toMatchObject({ isAborted: true }); expect(h.api.Popup.util.popups).toHaveLength(0);
    const controller = new h.api.SlashCommandAbortController();
    const success = h.run('/input onSuccess={: /setvar key=handler entered | /delay 60000 | /setvar key=late forbidden :} Question', { abortController: controller });
    (await popup(h)).okButton.click();
    await until(() => h.context.chatMetadata.variables.handler === 'entered' && h.timers.size === 1);
    controller.abort('closure cancelled', true); expect(await success).toMatchObject({ isAborted: true });
    expect(h.context.chatMetadata.variables.late).toBeUndefined(); expect(h.timers.size).toBe(0);
  } finally { h.dispose(); }
});

it.skipIf(!process.env.SILLYTAVERN_SLASH_ORACLE_ROOT)("retains exact original popup callback text and compares actual original Parser/DOM command results in both macro engines", async () => {
  const root = process.env.SILLYTAVERN_SLASH_ORACLE_ROOT!;
  const originalSource = readFileSync(resolve(root, 'public/scripts/slash-commands.js'), 'utf8');
  const adaptedSource = readFileSync(resolve('upstream-slash/DefaultCommands.js'), 'utf8');
  const ast: any = parse(originalSource, { ecmaVersion: 'latest', sourceType: 'module' });
  const callbackNames = ['inputCallback', 'popupCallback', 'buttonsCallback'];
  for (const item of ast.body) {
    const node = item.declaration ?? item;
    if (node.type === 'FunctionDeclaration' && callbackNames.includes(node.id.name)) expect(adaptedSource).toContain(originalSource.slice(node.start, node.end));
  }
  const rows: any[] = [];
  const cases = [
    { text: '/input default=seed onSuccess={: /setvar key=chosen success :} Question', action: 'input' },
    { text: '/prompt onCancel={: /setvar key=chosen cancel :} Question', action: 'cancel' },
    { text: '/popup cancelButton=No Body', action: 'cancel' },
    { text: '/popup result=true Body', action: 'ok' },
    { text: '/popup result=true Body', action: 'escape' },
    { text: '/buttons labels=["A","B"] Pick', action: 'single' },
    { text: '/buttons labels=["A","B"] multiple=true Pick', action: 'multiple' },
    { text: '/buttons labels=null Pick', action: null },
  ];
  for (const experimental of [false, true]) for (const item of cases) {
    const original = await fixture(root), actual = await fixture();
    try {
      for (const name of ['input', 'popup', 'buttons']) {
        const project = (command: any) => ({ aliases: command.aliases, arguments: command.namedArgumentList.map((arg: any) => ({ name: arg.name, types: arg.typeList, defaultValue: arg.defaultValue })) });
        expect(project(actual.api.SlashCommandParser.commands[name])).toEqual(project(original.api.SlashCommandParser.commands[name]));
      }
      const execute = async (h: typeof actual) => {
        h.power_user.experimental_macro_engine = experimental;
        const pending = h.run(item.text);
        if (item.action) {
          const shown = await popup(h);
          if (item.action === 'input') { shown.mainInput.value = 'entered'; shown.okButton.click(); }
          if (item.action === 'cancel') shown.cancelButton.click();
          if (item.action === 'ok') shown.okButton.click();
          if (item.action === 'escape') shown.dlg.dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
          if (item.action === 'single') shown.content.querySelector('[data-result="3"]').click();
          if (item.action === 'multiple') { const buttons = shown.content.querySelectorAll('[data-toggle-value]'); buttons[1].click(); buttons[0].click(); shown.okButton.click(); }
        }
        const result = await pending;
        return { pipe: result.pipe, isAborted: result.isAborted, isError: result.isError, variables: h.context.chatMetadata.variables, dialogs: h.api.Popup.util.popups.length };
      };
      const expected = await execute(original), observed = await execute(actual); expect(observed).toEqual(expected);
      rows.push({ experimental, ...item, expected, observed });
    } finally { original.dispose(); actual.dispose(); }
  }
  const report = process.env.MYCOMPANION_SLASH_POPUP_ORACLE_REPORT;
  if (report) writeFileSync(resolve(report), JSON.stringify({ passed: true, commit: '7e8663cd9c184a550b37238218bdd32c6efc68e9',
    scope: 'Pristine Parser/registrations/callbacks with product native Popup and actual jsdom DOM; native modal/animation platform methods supplied by fixture, not EXE acceptance',
    upstreamSha256: createHash('sha256').update(originalSource).digest('hex'), adaptedSha256: createHash('sha256').update(adaptedSource).digest('hex'), rows }, null, 2) + '\n', { flag: 'wx' });
}, 60_000);

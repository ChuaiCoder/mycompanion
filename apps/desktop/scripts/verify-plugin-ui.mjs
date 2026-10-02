import assert from 'node:assert/strict';

// Exercise the served modules, installed template files and Chromium modal DOM.
// Test fixtures are project-authored; this is not original-helper acceptance.
async function browserUiChecks() {
  const stages = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
  const wait = async predicate => { const until = Date.now() + 4000; while (!predicate()) { if (Date.now() > until) throw new Error('Popup UI wait timed out'); await tick(); } };
  const { Handlebars } = await import('/lib.js');
  const locale = await import('/scripts/i18n.js');
  const { t, translate, addLocaleData, getCurrentLocale, applyLocale } = locale;
  const { renderExtensionTemplate, renderExtensionTemplateAsync } = await import('/scripts/extensions.js');
  const { renderTemplate, renderTemplateAsync } = await import('/scripts/templates.js');
  const { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup, getTopmostModalLayer } = await import('/scripts/popup.js');
  check((await import('/plugin-runtime/scripts/popup.js')).Popup === Popup, 'Popup aliases must share registry and class');
  check((await import('/plugin-runtime/scripts/i18n.js')).t === t, 'Locale aliases must share catalog');
  check(POPUP_TYPE.TEXT === 1 && POPUP_TYPE.CONFIRM === 2 && POPUP_TYPE.INPUT === 3 && POPUP_TYPE.DISPLAY === 4 && POPUP_TYPE.CROP === 5 && POPUP_RESULT.CUSTOM9 === 1009 && POPUP_RESULT.CANCELLED === null, 'ST numeric popup contracts');
  stages.push('canonical-dialog-and-locale-modules-share-state');

  const translations = { 'fixture-template-caption': '已翻译标题', 'fixture-template-placeholder': '请输入', 'fixture-empty': '', 'fixture-greeting ${0} / ${1}': '${1} 欢迎 ${0}' };
  addLocaleData(getCurrentLocale(), translations);
  addLocaleData(getCurrentLocale(), { 'fixture-template-caption': 'must not overwrite' });
  addLocaleData('fixture-other-language', { 'fixture-other': 'must not apply' });
  check(translate('fallback', 'fixture-template-caption') === '已翻译标题' && translate('fixture-other') === 'fixture-other', 'Locale catalog merge or selection wrong');
  check(t`fixture-greeting ${'$&'} / ${'朋友'}` === '朋友 欢迎 $&', 'Tagged translations must reorder indexed values literally');
  check(applyLocale('<input data-i18n="[placeholder]fixture-template-placeholder">').includes('placeholder="请输入"'), 'Template attribute localization');
  const node = document.createElement('span'); node.dataset.i18n = 'fixture-template-caption'; document.body.append(node);
  await wait(() => node.textContent === '已翻译标题');
  node.dataset.i18n = 'fixture-empty'; await wait(() => node.textContent === ''); node.remove();
  stages.push('locale-catalog-tags-empty-values-and-observed-dom');

  Handlebars.registerHelper('fixtureUpper', text => String(text).toUpperCase());
  const data = { title: '<unsafe title>', enabled: true, items: ['first', 'second'], raw: '<b>allowed</b><img src="x" onerror="fixtureUnexpectedExecution()">' };
  const html = await renderExtensionTemplateAsync('third-party/success', 'views/form', data);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  check(parsed.querySelector('h3').textContent === '<UNSAFE TITLE>' && !parsed.querySelector('unsafe'), 'Handlebars helper and escaping');
  check(parsed.querySelectorAll('li').length === 2 && parsed.querySelector('li').textContent === '0: <unsafe title> / first', 'Block/parent/iteration template data');
  check(parsed.querySelector('b')?.textContent === 'allowed' && !parsed.querySelector('img').hasAttribute('onerror'), 'Default template sanitization');
  check(parsed.querySelector('span').textContent === '已翻译标题' && parsed.querySelector('input').placeholder === '请输入', 'Default template localization');
  const raw = await renderExtensionTemplateAsync('third-party/success', 'views/form', data, false, false);
  check(raw.includes('onerror=') && raw.includes('Default label'), 'Explicit template sanitize/localize flags');
  check(renderExtensionTemplate('third-party/success', 'views/form', { title: 'cached', items: [], enabled: false }).includes('CACHED'), 'Sync/async template cache with different input data');
  stages.push('extension-template-helpers-data-sanitize-localize-and-cache');
  const sync = renderExtensionTemplate('third-party/success', 'views/sync', { person: { name: '同步' } });
  check(sync === '同步', 'First-use synchronous XHR template');
  const defaultTemplate = await renderTemplateAsync('fixture-default', { title: 'Default template' });
  check(defaultTemplate === '<b>Default template</b>', 'Default host template URL');
  const absolute = location.origin + '/scripts/extensions/third-party/success/views/sync.html';
  check(renderTemplate(absolute, { person: { name: 'absolute' } }, true, false, true) === 'absolute', 'Full-path template URLs');
  stages.push('sync-first-load-default-template-and-full-path');
  const failed = await renderTemplateAsync('/fixture-templates/retry.html', {}, true, true, true);
  check(failed === undefined, 'Template request errors must not produce successful HTML');
  check((await renderTemplateAsync('/fixture-templates/retry.html', {}, true, true, true)) === '<b>Recovered</b>', 'Failed template request must be retryable');
  stages.push('template-http-error-is-visible-and-retry-recovers');
  Handlebars.unregisterHelper('fixtureUpper');

  let opened = false;
  const content = $('<section><input class="fixture-dialog-field" value="attached"><button class="fixture-dialog-action">Action</button></section>');
  let actions = 0; content.find('button').on('click', () => actions++);
  const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', { animation: 'none', onOpen: () => { opened = true; } });
  const shown = popup.show(); let settled = false; shown.then(() => { settled = true; });
  await wait(() => opened);
  check(popup.dlg.open && !settled && content[0].isConnected && getTopmostModalLayer() === popup.dlg, 'Real modal stays pending and attaches original jQuery nodes');
  content.find('button')[0].click(); check(actions === 1, 'Attached DOM event listener lost');
  popup.okButton.click(); check(await shown === 1 && !popup.dlg.isConnected, 'Confirm UI button must resolve affirmative and remove DOM');
  stages.push('real-confirmation-modal-node-identity-and-result');

  const input = new Popup('Input', POPUP_TYPE.INPUT, 'initial', { animation: 'none', rows: 2,
    placeholder: 'Main placeholder', customInputs: [{ id: 'flag:one', label: 'Flag', defaultState: true }, { id: 'quantity', type: 'number', label: 'Count', defaultState: 2, min: 1, max: 5 }] });
  const entered = input.show();
  check(document.activeElement === input.mainInput && input.mainInput.placeholder === 'Main placeholder', 'Input autofocus and options');
  input.mainInput.value = '';
  input.mainInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check(input.dlg.open, 'Plain Enter in multiline input must preserve editing');
  const quantity = input.dlg.querySelector('#quantity'); quantity.value = '99'; quantity.dispatchEvent(new Event('change'));
  input.mainInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  check(await entered === '' && input.inputResults.get('flag:one') === true && input.inputResults.get('quantity') === '5', 'Empty input, custom fields and number clamping');
  check(Popup.util.lastResult.value === '' && Popup.util.lastResult.result === 1, 'Popup lastResult');
  const negative = new Popup('', POPUP_TYPE.INPUT, '', { animation: 'none' }); const rejectedInput = negative.show(); negative.cancelButton.click(); check(await rejectedInput === false, 'Input negative differs from empty success');
  const helperInput = Popup.show.input('Title', 'Text', '', { animation: 'none' }); Popup.util.popups.at(-1).okButton.click(); check(await helperInput === '', 'Input helper preserves empty success');
  stages.push('input-keyboard-empty-negative-and-custom-results');

  let attempts = 0; let releaseClose; let insideClose = false;
  const guarded = new Popup('Guarded', POPUP_TYPE.CONFIRM, '', { animation: 'none',
    onClosing: async current => { attempts++; await tick(); check(current.result === 1, 'onClosing receives proposed result'); return attempts > 1; },
    onClose: async current => { insideClose = current.dlg.isConnected; await new Promise(resolve => { releaseClose = resolve; }); },
  });
  const guardedResult = guarded.show(); let guardedSettled = false; guardedResult.then(() => { guardedSettled = true; });
  await guarded.completeAffirmative();
  check(guarded.dlg.open && guarded.result === undefined && !guardedSettled, 'Async onClosing veto must keep dialog unresolved');
  const finish = guarded.completeAffirmative(); const duplicate = guarded.completeAffirmative();
  await wait(() => insideClose);
  check(attempts === 2 && !guardedSettled && insideClose, 'Repeated completion must not duplicate hooks; onClose before DOM disposal');
  releaseClose(); check(await guardedResult === 1 && await finish === 1 && await duplicate === 1, 'Completion promises resolve after cleanup');
  stages.push('async-closing-veto-single-completion-and-close-hook');

  let actionCount = 0;
  const buttons = new Popup('Buttons', POPUP_TYPE.TEXT, '', { animation: 'none', okButton: false,
    customButtons: [{ text: 'Action only', action: () => actionCount++, classes: 'fixture-action important' }, { text: 'Done', result: POPUP_RESULT.CUSTOM1, appendAtEnd: true }, 'Alternate'],
  });
  const buttonsResult = buttons.show(); buttons.dlg.querySelector('.fixture-action').click();
  check(actionCount === 1 && buttons.dlg.open && getComputedStyle(buttons.okButton).display === 'none', 'Action-only buttons must not close');
  buttons.dlg.querySelector('[data-result="1001"]').click(); check(await buttonsResult === 1001, 'Custom result value');
  stages.push('custom-button-actions-order-and-result');

  const outer = new Popup('Outer', POPUP_TYPE.INPUT, 'focus', { animation: 'none' }); const outerResult = outer.show(); outer.mainInput.focus();
  const inner = new Popup('Inner', POPUP_TYPE.DISPLAY, '', { animation: 'none' }); const innerResult = inner.show();
  toastr.info('Inside nested dialog'); check(inner.dlg.contains(document.getElementById('toast-container')), 'Nested modal must show notifications above backdrop');
  check(getComputedStyle(inner.buttonControls).display === 'none' && !inner.closeButton.hidden, 'Display has close button only');
  inner.closeButton.click(); check(await innerResult === null && document.activeElement === outer.mainInput && outer.dlg.contains(document.getElementById('toast-container')), 'Nested close restores focus and toast layer');
  outer.dlg.dispatchEvent(new Event('cancel', { cancelable: true })); check(await outerResult === null, 'Cancel event must return null');
  stages.push('nested-dialog-display-escape-focus-and-notifications');

  const blocked = new Popup('Blocking', POPUP_TYPE.TEXT, '', { animation: 'none', allowEscapeClose: false }); const blockedResult = blocked.show();
  blocked.dlg.dispatchEvent(new Event('cancel', { cancelable: true })); check(blocked.dlg.open, 'Single Escape must preserve blocking popup');
  blocked.dlg.dispatchEvent(new Event('cancel', { cancelable: true }));
  await wait(() => Popup.util.popups.length === 2);
  Popup.util.popups.at(-1).okButton.click(); check(await blockedResult === null, 'Double Escape force-close confirmation');
  stages.push('blocking-dialog-double-escape-confirmation');

  const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 40, 40); ctx.fillStyle = '#0000ff'; ctx.fillRect(40, 0, 40, 40);
  const crop = new Popup('Crop', POPUP_TYPE.CROP, '', { animation: 'none', cropAspect: 1, cropImage: canvas.toDataURL() });
  const cropped = crop.show(); await crop.cropReady;
  $(crop.cropImage).data('cropper').setData({ x: 0, y: 0, width: 40, height: 40 });
  crop.okButton.click(); const imageUrl = await cropped;
  check(imageUrl.startsWith('data:image/jpeg;base64,') && crop.cropData.width > 0 && !$(crop.cropImage).data('cropper'), 'Real Cropper output and destruction');
  const image = new Image(); image.src = imageUrl; await image.decode();
  check(image.width === 40 && image.height === 40, 'Crop output dimensions');
  const pixels = document.createElement('canvas'); pixels.width = image.width; pixels.height = image.height;
  const paint = pixels.getContext('2d'); paint.drawImage(image, 0, 0); const rgb = paint.getImageData(20, 20, 1, 1).data;
  check(rgb[0] > 240 && rgb[2] < 20, 'Crop must use selected source pixels');
  stages.push('interactive-cropper-selection-decoded-size-and-pixels');
  const generic = callGenericPopup('<b>Generic</b>', POPUP_TYPE.TEXT, '', { animation: 'none' }); Popup.util.popups.at(-1).okButton.click(); check(await generic === 1, 'Generic popup must await actual interaction');
  check(!Popup.util.isPopupOpen() && Popup.util.popups.length === 0 && getTopmostModalLayer() === document.body, 'All dialogs and registrations cleaned up');
  stages.push('generic-popup-and-final-modal-cleanup');
  toastr.clear();
  return { stages };
}

export async function verifyPluginUi(window, requests) {
  const report = await window.webContents.executeJavaScript('(' + browserUiChecks.toString() + ')().catch(error => { throw new Error(error.stack || String(error)); })');
  assert.equal(requests.get('/scripts/extensions/third-party/success/views/form.html'), 1, 'Template cache must fetch once across asynchronous and synchronous calls');
  assert.equal(requests.get('/scripts/extensions/third-party/success/views/sync.html'), 1);
  assert.equal(requests.get('/fixture-templates/retry.html'), 2);
  return report;
}

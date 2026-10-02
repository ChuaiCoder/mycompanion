// Own DOM implementation of ST's popup contract; no Tavern document or templates.
// Native Chromium dialogs supply focus trapping and the modal top layer.
export const popupRuntimeSource = String.raw`
import { Cropper, toastr, $ } from '/lib.js';
import { translate, applyLocale } from '/plugin-runtime/i18n.js';
export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 };
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null,
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => ['CUSTOM' + (index + 1), 1001 + index])) };
const style = document.createElement('style');
style.textContent = 
  '.mc-extension-popup{width:min(560px,90vw);max-width:94vw;max-height:90vh;padding:24px;border:1px solid var(--border,#ddd);border-radius:14px;color:var(--text,#222);background:var(--surface,#fff);box-shadow:0 16px 65px #0004;overflow:auto}' +
  '.mc-extension-popup [hidden]{display:none!important}.mc-extension-popup::backdrop{background:#0006}.mc-extension-popup .popup-body{min-width:0}.mc-extension-popup .popup-content{overflow-wrap:anywhere;text-align:center}' +
  '.mc-extension-popup .popup-input{width:100%;margin-top:14px;resize:vertical}.mc-extension-popup .popup-inputs label{display:flex;gap:10px;align-items:center;margin:12px 0}' +
  '.mc-extension-popup input:not([type=checkbox]),.mc-extension-popup textarea{border:1px solid var(--border,#ccc);border-radius:6px;padding:8px;background:var(--surface,#fff);color:inherit;max-width:100%}' +
  '.mc-extension-popup .popup-controls{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:20px}.mc-extension-popup button{padding:8px 14px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--surface,#f5f5f5);color:inherit}' +
  '.mc-extension-popup button.menu_button_default{background:var(--accent,#536dfe);color:white}.mc-extension-popup .popup-button-close{position:absolute;right:8px;top:8px}.mc-extension-popup .popup-crop-wrap{height:min(55vh,500px)}.mc-extension-popup .popup-crop-image{max-width:100%;max-height:55vh}' +
  '.mc-extension-popup.wide_dialogue_popup{width:85vw;min-height:65vh}.mc-extension-popup.wider_dialogue_popup{width:85vw}.mc-extension-popup.large_dialogue_popup{width:90vw;height:90vh}' +
  '.mc-extension-popup.transparent_dialogue_popup{background:transparent;border:0;box-shadow:none}.mc-extension-popup.left_aligned_dialogue_popup .popup-content{text-align:left}' +
  '.mc-extension-popup.horizontal_scrolling_dialogue_popup{overflow-x:auto}.mc-extension-popup.vertical_scrolling_dialogue_popup{overflow-y:auto}' +
  '@keyframes mc-popup-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes mc-popup-out{from{opacity:1}to{opacity:0}}' +
  '.mc-extension-popup[opening]:not(.popup--animation-none){animation:mc-popup-in .1s ease}.mc-extension-popup[closing]:not(.popup--animation-none){animation:mc-popup-out .1s ease}.mc-extension-popup.popup--animation-slow{animation-duration:.2s}';
document.head.append(style);
const element = (tag, classes, parent) => { const node = document.createElement(tag); node.className = classes; parent?.append(node); return node; };
const animate = dialog => Promise.all(dialog.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
function failure(error) { console.error('Popup action failed', error); toastr.error(error?.message || String(error)); }
export function getTopmostModalLayer() { return [...document.querySelectorAll('dialog[open]:not([closing])')].at(-1) || document.body; }
export function fixToastrForDialogs() {
  const layer = getTopmostModalLayer();
  let container = document.getElementById('toast-container');
  if (!container && layer !== document.body) {
    container = element('div', toastr.options.positionClass || 'toast-top-right'); container.id = 'toast-container';
  }
  if (container && container.parentElement !== layer) layer.append(container);
  if (container && layer === document.body && !container.childNodes.length) container.remove();
}
export class PopupUtils {
  static BuildTextWithHeader(header, text) { return header ? '<h3>' + header + '</h3>\n' + (text ?? '') : text; }
}
export class Popup {
  static util = { popups: [], lastResult: null,
    isPopupOpen: () => Popup.util.popups.some(popup => popup.dlg.open), getTopmostModalLayer };
  static show = {
    input: async (header, text, value = '', options = {}) => {
      const result = await new Popup(PopupUtils.BuildTextWithHeader(header, text), POPUP_TYPE.INPUT, value, options).show();
      return result === '' ? '' : result ? String(result) : null;
    },
    confirm: (header, text, options = {}) => new Popup(PopupUtils.BuildTextWithHeader(header, text), POPUP_TYPE.CONFIRM, '', options).show(),
    text: (header, text, options = {}) => new Popup(PopupUtils.BuildTextWithHeader(header, text), POPUP_TYPE.TEXT, '', options).show(),
  };
  constructor(content, type, inputValue = '', options = {}) {
    this.id = crypto.randomUUID(); this.type = type; this.options = options;
    this.defaultResult = options.defaultResult === undefined ? POPUP_RESULT.AFFIRMATIVE : options.defaultResult;
    this.customButtons = options.customButtons; this.customInputs = options.customInputs;
    this.onOpen = options.onOpen; this.onClosing = options.onClosing; this.onClose = options.onClose;
    this.state = 'created';
    this.dlg = element('dialog', 'popup mc-extension-popup'); this.dlg.dataset.id = this.id;
    this.body = element('div', 'popup-body', this.dlg);
    this.content = element('div', 'popup-content', this.body);
    this.mainInput = element('textarea', 'popup-input text_pole result-control', this.body);
    this.mainInput.value = inputValue ?? ''; this.mainInput.rows = options.rows ?? 1;
    this.mainInput.placeholder = options.placeholder ?? ''; this.mainInput.title = options.tooltip ?? '';
    this.mainInput.hidden = type !== POPUP_TYPE.INPUT;
    this.inputControls = element('div', 'popup-inputs', this.body);
    this.cropWrap = element('div', 'popup-crop-wrap', this.body);
    this.cropImage = element('img', 'popup-crop-image', this.cropWrap);
    this.cropWrap.hidden = type !== POPUP_TYPE.CROP;
    this.buttonControls = element('div', 'popup-controls', this.body);
    const caption = (value, fallback) => typeof value === 'string' ? value : translate(fallback);
    this.okButton = this.makeButton(caption(options.okButton, type === POPUP_TYPE.CONFIRM ? 'Yes' : type === POPUP_TYPE.INPUT ? 'Save' : type === POPUP_TYPE.CROP ? 'Crop' : 'OK'), 'popup-button-ok', 1);
    this.cancelButton = this.makeButton(caption(options.cancelButton, type === POPUP_TYPE.CONFIRM ? 'No' : 'Cancel'), 'popup-button-cancel', 0);
    this.closeButton = this.makeButton('×', 'popup-button-close', null, this.body);
    this.closeButton.setAttribute('aria-label', translate('Close'));
    this.okButton.hidden = options.okButton === false;
    this.cancelButton.hidden = options.cancelButton === false || (type === POPUP_TYPE.TEXT && !options.cancelButton);
    this.buttonControls.hidden = type === POPUP_TYPE.DISPLAY;
    this.closeButton.hidden = type !== POPUP_TYPE.DISPLAY;
    for (const [option, className] of Object.entries({ wide: 'wide', wider: 'wider', large: 'large', transparent: 'transparent', allowHorizontalScrolling: 'horizontal_scrolling', allowVerticalScrolling: 'vertical_scrolling', leftAlign: 'left_aligned' })) {
      if (options[option]) this.dlg.classList.add(className + '_dialogue_popup');
    }
    this.dlg.classList.add('popup--animation-' + (options.animation ?? 'fast'));
    if (content?.jquery) this.content.append(...content.toArray());
    else if (content instanceof Node) this.content.append(content);
    else if (content != null) this.content.innerHTML = String(content);
    const heading = this.content.querySelector('h1,h2,h3');
    if (heading) { heading.id ||= 'popup-title-' + this.id; this.dlg.setAttribute('aria-labelledby', heading.id); }
    else this.dlg.setAttribute('aria-label', this.content.textContent.trim().slice(0, 200) || translate('Dialog'));
    if (type !== POPUP_TYPE.INPUT && options.tooltip) this.content.title = options.tooltip;
    for (const [index, item] of (options.customButtons || []).entries()) {
      const config = typeof item === 'string' ? { text: item, result: index + 2 } : item;
      const button = this.makeButton(config.text, 'popup-button-custom', config.result);
      if (!config.appendAtEnd) this.buttonControls.insertBefore(button, this.okButton);
      button.classList.add(...(Array.isArray(config.classes) ? config.classes : String(config.classes || '').split(/\s+/)).filter(Boolean));
      if (config.tooltip) button.title = config.tooltip;
      if (config.icon) { const icon = element('i', 'fa-solid ' + config.icon); button.prepend(icon); }
      if (config.action) button.addEventListener('click', () => { try { Promise.resolve(config.action()).catch(failure); } catch (error) { failure(error); } });
    }
    for (const config of options.customInputs || []) {
      if (!config.id || !['checkbox', 'text', 'textarea', 'number'].includes(config.type ?? 'checkbox')) continue;
      const label = element('label', 'popup-custom-input', this.inputControls); label.htmlFor = config.id;
      const text = element('span', '', label); text.textContent = config.label; text.dataset.i18n = config.label;
      const input = element(config.type === 'textarea' ? 'textarea' : 'input', 'text_pole result-control', label);
      input.id = config.id;
      if (config.type === 'textarea') input.rows = config.rows ?? 1; else input.type = config.type ?? 'checkbox';
      if (input.type === 'checkbox') input.checked = Boolean(config.defaultState ?? false); else input.value = String(config.defaultState ?? '');
      input.disabled = Boolean(config.disabled); input.autofocus = Boolean(config.autoFocus);
      if (config.tooltip) { input.title = config.tooltip; input.placeholder = config.tooltip; }
      if (config.type === 'number') {
        for (const key of ['min', 'max', 'step']) if (config[key] != null) input[key] = String(config[key]);
        input.addEventListener('change', () => {
          const value = Number.parseFloat(input.value);
          if (!Number.isNaN(value)) input.value = String(Math.min(config.max ?? Infinity, Math.max(config.min ?? -Infinity, value)));
        });
      }
    }
    for (const control of this.dlg.querySelectorAll('[data-result]')) {
      if (control.dataset.result === 'undefined') continue;
      const result = control.dataset.result === 'null' ? null : Number(control.dataset.result);
      if (result !== null && !Number.isFinite(result)) throw new Error('Invalid popup result: ' + control.dataset.result);
      control.addEventListener(control.dataset.resultEvent || 'click', () => { void this.complete(result).catch(failure); });
    }
    this.dlg.querySelector('[data-result="' + this.defaultResult + '"]')?.classList.add('menu_button_default');
    this.setAutoFocus({ applyAutoFocus: true });
    this.dlg.addEventListener('focusin', event => { if (event.target !== this.dlg) this.lastFocus = event.target; });
    this.dlg.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); void this.cancelFromEscape().catch(failure); });
    this.dlg.addEventListener('close', () => {
      if (this.state !== 'open') return;
      this.dlg.showModal();
      if (this.options.allowEscapeClose !== false) void this.completeCancelled().catch(failure);
    });
    this.dlg.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || this.dlg !== document.activeElement?.closest('.popup')) return;
      const control = document.activeElement?.closest('.result-control');
      if (!control || control.disabled) return;
      if (control.matches('input,textarea') && this.mainInput.rows > 1 && !event.ctrlKey) return;
      event.preventDefault(); event.stopPropagation();
      if (control instanceof HTMLButtonElement) control.click();
      else void this.complete(this.defaultResult).catch(failure);
    });
    Popup.util.popups.push(this);
  }
  makeButton(text, classes, result, parent = this.buttonControls) {
    const button = element('button', 'menu_button result-control ' + classes, parent);
    button.type = 'button'; button.textContent = text; button.dataset.result = String(result); return button;
  }
  setAutoFocus({ applyAutoFocus = false } = {}) {
    const available = node => node && !node.hidden && !node.disabled && !node.closest('[hidden]');
    const control = [...this.dlg.querySelectorAll('[autofocus]')].find(available)
      || (this.type === POPUP_TYPE.INPUT ? this.mainInput : null)
      || [...this.buttonControls.querySelectorAll('[data-result="' + this.defaultResult + '"]')].find(available)
      || [...this.dlg.querySelectorAll('button,input,textarea')].find(available);
    if (!control) return;
    if (applyAutoFocus) control.autofocus = true; else control.focus();
  }
  show() {
    if (this.promise) return this.promise;
    this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.previousFocus = document.activeElement; this.state = 'open';
    document.body.append(this.dlg); this.dlg.setAttribute('opening', '');
    applyLocale(this.dlg); this.dlg.showModal(); this.setAutoFocus(); fixToastrForDialogs();
    if (this.type === POPUP_TYPE.CROP) this.startCrop();
    void animate(this.dlg).then(async () => {
      this.dlg.removeAttribute('opening');
      if (this.state === 'open') await this.onOpen?.(this);
    }).catch(error => { this.dispose(); this.reject(error); });
    return this.promise;
  }
  startCrop() {
    this.cropReady = new Promise((resolve, reject) => {
      this.cropImage.addEventListener('error', () => reject(new Error('Could not load crop image')), { once: true });
      this.cropImage.addEventListener('ready', resolve, { once: true });
      this.cropImage.src = this.options.cropImage ?? '';
      this.cropper = new Cropper(this.cropImage, { aspectRatio: this.options.cropAspect ?? 2 / 3, autoCropArea: 1, viewMode: 2, rotatable: false,
        crop: event => { this.cropData = { ...event.detail, want_resize: true }; },
      });
      $(this.cropImage).data('cropper', this.cropper);
    });
    void this.cropReady.catch(failure);
  }
  async cancelFromEscape() {
    if (this.options.allowEscapeClose !== false) return this.completeCancelled();
    const now = performance.now();
    const twice = this.lastEscape != null && now - this.lastEscape < 500;
    this.lastEscape = now;
    if (!twice || this.forcePopup) return;
    const confirmation = this.forcePopup = new Popup('强制关闭此弹窗？未完成的操作可能被中断。', POPUP_TYPE.CONFIRM);
    const result = await confirmation.show();
    this.forcePopup = null;
    if (result === POPUP_RESULT.AFFIRMATIVE && this.state === 'open') return this.completeCancelled();
  }
  complete(result) {
    if (this.state === 'closed') return this.promise;
    if (this.completing) return this.completing;
    if (this.state === 'created') this.show();
    const attempt = this.finish(result);
    this.completing = attempt;
    void attempt.finally(() => { if (this.completing === attempt) this.completing = null; }).catch(() => {});
    return attempt;
  }
  async finish(result) {
    let value = result;
    if (this.type === POPUP_TYPE.INPUT) value = result >= 1 ? this.mainInput.value : result === null ? null : false;
    if (this.type === POPUP_TYPE.CROP) {
      value = null;
      if (result >= 1) { await this.cropReady; value = this.cropper.getCroppedCanvas().toDataURL('image/jpeg'); }
    }
    this.result = result; this.value = value;
    if (this.customInputs?.length) this.inputResults = new Map(this.customInputs.flatMap(config => {
      const input = this.dlg.querySelector('#' + CSS.escape(config.id));
      return input ? [[config.id, input.type === 'checkbox' ? input.checked : input.value]] : [];
    }));
    try {
      if (this.onClosing && !await this.onClosing(this)) { this.result = this.value = this.inputResults = undefined; return undefined; }
    } catch (error) { this.result = this.value = this.inputResults = undefined; throw error; }
    this.state = 'closing';
    Popup.util.lastResult = { result, value, inputResults: this.inputResults };
    this.dlg.removeAttribute('opening'); this.dlg.setAttribute('closing', ''); fixToastrForDialogs();
    if (this.forcePopup) await this.forcePopup.completeCancelled();
    await animate(this.dlg);
    this.dlg.close();
    try { await this.onClose?.(this); }
    catch (error) { this.reject(error); throw error; }
    finally { this.dispose(); }
    this.resolve(value);
    return value;
  }
  dispose() {
    this.state = 'closed'; this.cropper?.destroy(); $(this.cropImage).removeData('cropper');
    this.dlg.remove();
    const index = Popup.util.popups.indexOf(this); if (index >= 0) Popup.util.popups.splice(index, 1);
    fixToastrForDialogs();
    const active = Popup.util.popups.filter(popup => popup.dlg.open).at(-1);
    if (active) { if (active.lastFocus?.isConnected) active.lastFocus.focus(); else active.setAutoFocus(); }
    else if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
  completeAffirmative() { return this.complete(POPUP_RESULT.AFFIRMATIVE); }
  completeNegative() { return this.complete(POPUP_RESULT.NEGATIVE); }
  completeCancelled() { return this.complete(POPUP_RESULT.CANCELLED); }
}
export const callGenericPopup = (content, type, inputValue = '', options = {}) => new Popup(content, type, inputValue, options).show();
`;

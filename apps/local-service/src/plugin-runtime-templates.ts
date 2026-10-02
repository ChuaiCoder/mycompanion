// Independently implemented against the public ST 1.19.0 template/locale API.
// Handlebars and DOMPurify are the pinned shared libraries used by extensions.
export const localeRuntimeSource = String.raw`
import { extension_settings, loadExtensionSettings } from '/plugin-runtime/settings.js';
const normalizeLocale = value => String(value || 'zh-CN').toLowerCase().startsWith('zh') ? 'zh-cn' : String(value).toLowerCase().startsWith('en') ? 'en' : String(value).toLowerCase();
let locale = normalizeLocale(document.documentElement.lang || navigator.language);
let languageRevision = 0;
const extraCatalogs = new Map();
const chinese = {
  OK: '确定', Cancel: '取消', Yes: '是', No: '否', Save: '保存', Crop: '裁剪', Close: '关闭',
};
const catalog = new Map();
function setLocale(value) {
  locale = normalizeLocale(value);
  catalog.clear();
  for (const [key, translation] of Object.entries(locale === 'zh-cn' ? chinese : {})) catalog.set(key, translation);
  for (const [key, translation] of extraCatalogs.get(locale) || []) if (!catalog.has(key)) catalog.set(key, translation);
  document.documentElement.lang = locale === 'zh-cn' ? 'zh-CN' : locale;
}
setLocale(locale);
export const getCurrentLocale = () => locale;
export function addLocaleData(localeId, data) {
  const id = normalizeLocale(localeId);
  if (!extraCatalogs.has(id)) extraCatalogs.set(id, new Map());
  for (const [key, value] of Object.entries(data || {})) {
    if (!extraCatalogs.get(id).has(key)) extraCatalogs.get(id).set(key, value);
    if (id === locale && !catalog.has(key)) catalog.set(key, value);
  }
}
export function translate(text, key = null) {
  const lookup = key || text;
  return lookup == null ? '' : (catalog.get(lookup) || text);
}
export function t(strings, ...values) {
  if (!Array.isArray(strings)) return translate(String(strings));
  const key = strings.reduce((result, part, index) => result + part + (values[index] !== undefined ? '$' + '{' + index + '}' : ''), '');
  return String(translate(key)).replace(/\$\{(\d+)\}/g, (_match, index) => values[index]);
}
function translateElement(element) {
  for (const entry of (element.getAttribute('data-i18n') || '').split(';')) {
    const attribute = entry.match(/^\[([^\]]+)\](.+)$/);
    const value = catalog.get(attribute ? attribute[2] : entry);
    if (!value && value !== '') continue;
    if (attribute) {
      if (element.getAttribute(attribute[1]) !== String(value)) element.setAttribute(attribute[1], value);
    } else if (element.textContent !== String(value)) element.textContent = value;
  }
}
function localizeTree(root) {
  if (root instanceof Element && root.hasAttribute('data-i18n')) translateElement(root);
  root.querySelectorAll?.('[data-i18n]').forEach(translateElement);
}
export function applyLocale(root = document) {
  if (!catalog.size) return root;
  if (typeof root === 'string') {
    const parsed = new DOMParser().parseFromString(root, 'text/html');
    localizeTree(parsed);
    return parsed.body.innerHTML;
  }
  localizeTree(root);
  return root === document ? undefined : root;
}
const observer = new MutationObserver(changes => {
  for (const change of changes) {
    if (change.type === 'attributes') translateElement(change.target);
    else for (const node of change.addedNodes) if (node instanceof Element) localizeTree(node);
  }
});
export async function initLocales() {
  const revision = languageRevision;
  await loadExtensionSettings();
  const preference = extension_settings.__mycompanion_preferences?.language;
  if (revision === languageRevision && (preference === 'zh' || preference === 'en')) setLocale(preference);
  applyLocale();
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-i18n'] });
}
const languageChanged = event => {
  const value = event.detail?.language;
  if (value !== 'zh-CN' && value !== 'en-US') return;
  languageRevision++;
  setLocale(value);
  applyLocale();
};
window.addEventListener('mycompanion:language-changed', languageChanged);
void initLocales().catch(error => console.error('Extension locale initialization failed', error));
window.addEventListener('pagehide', () => {
  observer.disconnect(); window.removeEventListener('mycompanion:language-changed', languageChanged);
}, { once: true });
`;

export const templateRuntimeSource = String.raw`
import { Handlebars, DOMPurify, toastr } from '/lib.js';
import { applyLocale } from '/plugin-runtime/i18n.js';
const templates = new Map();
const loading = new Map();
const templateUrl = (id, fullPath) => new URL(fullPath ? id : '/scripts/templates/' + id + '.html', location.href).href;
function render(compiled, data, sanitize, localize) {
  let html = compiled(data);
  if (sanitize) html = DOMPurify.sanitize(html);
  return localize ? applyLocale(html) : html;
}
function reportError(id, error) {
  console.error('Error rendering template', id, error);
  toastr.error('Check the DevTools console for more information.', 'Error rendering template');
}
export async function renderTemplateAsync(id, data = {}, sanitize = true, localize = true, fullPath = false) {
  try {
    const url = templateUrl(id, fullPath);
    if (!templates.has(url)) {
      if (!loading.has(url)) {
        const request = (async () => {
          const response = await fetch(url);
          if (!response.ok) throw new Error('Error loading ' + url + ': ' + response.status + ' ' + response.statusText);
          const compiled = Handlebars.compile(await response.text());
          templates.set(url, compiled);
          return compiled;
        })();
        loading.set(url, request);
      }
      try { await loading.get(url); } finally { loading.delete(url); }
    }
    return render(templates.get(url), data, sanitize, localize);
  } catch (error) { reportError(id, error); }
}
export function renderTemplate(id, data = {}, sanitize = true, localize = true, fullPath = false) {
  try {
    const url = templateUrl(id, fullPath);
    if (!templates.has(url)) {
      const request = new XMLHttpRequest();
      request.open('GET', url, false);
      request.send();
      if (request.status < 200 || request.status >= 300) throw new Error('Error loading ' + url + ': ' + request.status + ' ' + request.statusText);
      templates.set(url, Handlebars.compile(request.responseText));
    }
    return render(templates.get(url), data, sanitize, localize);
  } catch (error) { reportError(id, error); }
}
const extensionTemplate = (name, id) => '/scripts/extensions/' + name + '/' + id + '.html';
export const renderExtensionTemplateAsync = (name, id, data = {}, sanitize = true, localize = true) =>
  renderTemplateAsync(extensionTemplate(name, id), data, sanitize, localize, true);
export const renderExtensionTemplate = (name, id, data = {}, sanitize = true, localize = true) =>
  renderTemplate(extensionTemplate(name, id), data, sanitize, localize, true);
`;

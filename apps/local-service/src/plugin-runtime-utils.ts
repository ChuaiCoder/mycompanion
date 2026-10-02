// Browser implementations of the utility contracts used by extensions.
// Keep these independent of the host's UI so they can also run in script frames.
export const utilityRuntimeSource = String.raw`
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function debounce(fn, wait = 300) {
  let timer;
  return function(...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), wait); };
}
export function throttle(fn, wait = 300) {
  let last = -Infinity;
  return function(...args) {
    const now = Date.now();
    if (now - last >= wait) { last = now; return fn.apply(this, args); }
  };
}
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const isTrueBoolean = value => value === true || (typeof value === 'string' && ['on','true','1'].includes(value.trim().toLowerCase()));
export const isFalseBoolean = value => value === false || (typeof value === 'string' && ['off','false','0'].includes(value.trim().toLowerCase()));
export const onlyUnique = (value, index, array) => array.indexOf(value) === index;
export const uuidv4 = () => crypto.randomUUID();

// cyrb53 by bryc, 2018, public domain / MIT. Same stable hash used by ST.
// https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js
export function getStringHash(str, seed = 0) {
  if (typeof str !== 'string') return 0;
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    h1 = Math.imul(h1 ^ str.charCodeAt(i), 2654435761);
    h2 = Math.imul(h2 ^ str.charCodeAt(i), 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export function regexFromString(value) {
  try { const match = /^\/(.*)\/([a-z]*)$/i.exec(value); return match ? new RegExp(match[1], match[2]) : new RegExp(value); }
  catch { return undefined; }
}
export const isValidUrl = value => { try { new URL(value); return true; } catch { return false; } };
export const isDataURL = value => typeof value === 'string' && /^data:([a-z]+\/[a-z0-9-+.]+(;[a-z-]+=[a-z0-9-]+)*;?)?(base64)?,([a-z0-9!$&',()*+;=\-_%.~:@/?#]+)?$/i.test(value);

export class Stopwatch {
  constructor(interval) {
    this.interval = Number.isFinite(Number(interval)) && Number(interval) > 0 ? Number(interval) : 1;
    this.lastAction = Date.now();
  }
  async tick(action) {
    if (Date.now() - this.lastAction < this.interval) return;
    await action();
    this.lastAction = Date.now();
  }
}

export function getBase64Async(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onabort = () => reject(new DOMException('File read aborted', 'AbortError'));
    reader.readAsDataURL(file);
  });
}
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load image'));
    image.src = url;
  });
}
export async function getImageSizeFromDataURL(dataUrl) {
  const image = await loadImage(dataUrl);
  return { width: image.naturalWidth, height: image.naturalHeight };
}
export const supportedImageMimeTypes = Object.freeze([
  'image/jpeg', 'image/png', 'image/bmp', 'image/tiff', 'image/gif', 'image/apng', 'image/webp', 'image/avif',
]);
export async function ensureImageFormatSupported(file) {
  if (supportedImageMimeTypes.includes(file.type) || !file.type.startsWith('image/')) return file;
  const image = await loadImage(await getBase64Async(file));
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image conversion unavailable');
  context.drawImage(image, 0, 0);
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image conversion failed')), 'image/png'));
  return new File([blob], file.name, { type: 'image/png', lastModified: file.lastModified });
}
export function getCharaFilename(chid = null, { manualAvatarKey = null } = {}) {
  const context = globalThis.SillyTavern.getContext();
  const characterId = chid ?? context.characterId;
  const characters = context.characters;
  const character = characters[characterId] ?? characters.find(item => item.id === characterId);
  return (manualAvatarKey ?? character?.avatar)?.replace(/\.[^/.]+$/, '') ?? null;
}
export async function getSanitizedFilename(fileName) {
  const response = await fetch('/api/files/sanitize-filename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName }),
  });
  if (!response.ok) throw new Error('Could not sanitize filename: ' + await response.text());
  return (await response.json()).fileName;
}
export function download(content, fileName, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export async function showFontAwesomePicker(customList = null) {
  let items = customList;
  if (items === null) {
    const response = await fetch('/plugin-runtime/vendor/fontawesome/icons.json');
    if (!response.ok) throw new Error('Unable to load icon list: ' + response.status);
    items = await response.json();
  }
  const icons = items.map(item => typeof item === 'string' ? [item] : item);
  const dialog = document.createElement('dialog');
  dialog.className = 'mc-icon-picker';
  dialog.setAttribute('aria-label', '选择图标');
  dialog.style.cssText = 'width:min(560px,90vw);max-height:80vh;border:1px solid #aaa;border-radius:10px;padding:16px;color:inherit;background:Canvas;';
  const query = document.createElement('input');
  query.type = 'search'; query.placeholder = '搜索图标'; query.setAttribute('aria-label', '搜索图标');
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(55px,1fr));gap:6px;max-height:55vh;overflow:auto;margin:12px 0';
  const clear = document.createElement('button'); clear.textContent = '无图标';
  const cancel = document.createElement('button'); cancel.textContent = '取消';
  dialog.append(query, grid, clear, cancel);
  return new Promise(resolve => {
    let result = null;
    const finish = value => { result = value; dialog.close(); };
    for (const names of icons) {
      if (!names.length || names.some(name => typeof name !== 'string' || !/^fa-[a-z0-9-]+$/i.test(name))) continue;
      const button = document.createElement('button');
      button.type = 'button'; button.title = names.join(', '); button.setAttribute('aria-label', names[0]);
      const icon = document.createElement('i'); icon.classList.add('fa-solid', names[0]); icon.setAttribute('aria-hidden', 'true');
      button.append(icon); button.dataset.search = names.join(' ').toLowerCase();
      button.addEventListener('click', () => finish(names[0])); grid.append(button);
    }
    query.addEventListener('input', () => {
      for (const button of grid.children) button.hidden = !button.dataset.search.includes(query.value.toLowerCase());
    });
    clear.addEventListener('click', () => finish(''));
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
    document.body.append(dialog); dialog.showModal(); query.focus();
  });
}
`;

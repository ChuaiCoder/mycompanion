// Data/assembly classes only. OpenAI settings, presets and request streaming
// are separate implementations; do not supply successful no-op exports.
export const completionCollectionsSource = String.raw`
import { countTokensOpenAIAsync } from '/scripts/tokenizers.js';
import { getImageSizeFromDataURL, getBase64Async } from '/scripts/utils.js';
import {oai_settings} from '/plugin-runtime/openai-settings.js';

export class IdentifierNotFoundError extends Error {
  constructor(identifier) { super('Identifier ' + identifier + ' not found.'); this.name = 'IdentifierNotFoundError'; }
}
export class TokenBudgetExceededError extends Error {
  constructor(identifier = '') { super('Token budget exceeded. Message: ' + identifier); this.name = 'TokenBudgetExceeded'; }
}
export class Message {
  static tokensPerImage = 85;
  name; tool_call = null; signature = null; reasoning = null;
  constructor(role, content, identifier) { this.role = role || 'system'; this.content = content; this.identifier = identifier; this.tokens = 0; }
  static async createAsync(role, content, identifier) {
    const message = new Message(role, content, identifier);
    if (content?.length) await message.recount();
    return message;
  }
  static fromPromptAsync(prompt) { return Message.createAsync(prompt.role, prompt.content, prompt.identifier); }
  getTokens() { return this.tokens; }
  async recount() {
    const fields = { role: this.role, content: this.content };
    if (this.name !== undefined) fields.name = this.name;
    if (this.tool_calls) fields.tool_calls = JSON.stringify(this.tool_calls);
    if (this.reasoning) fields.reasoning = this.reasoning;
    let tokens = await countTokensOpenAIAsync(fields);
    if (Array.isArray(this.content)) for (const part of this.content) {
      if (part.type === 'image_url') {
        try { tokens += await this.getImageTokenCost(part.image_url.url, part.image_url.detail || 'auto') - Message.tokensPerImage; }
        catch { /* The text counter already reserves the low-detail image cost. */ }
      }
    }
    this.tokens = tokens;
  }
  async setName(name) { this.name = name; await this.recount(); }
  async setToolCalls(invocations, includeSignature, includeReasoning = false) {
    this.tool_calls = invocations.map(item => ({ id: item.id, type: 'function', function: { name: item.name, arguments: item.parameters }, ...(includeSignature && item.signature ? { signature: item.signature } : {}) }));
    this.reasoning = includeReasoning ? invocations.find(item => typeof item.reasoning === 'string' && item.reasoning)?.reasoning || null : null;
    await this.recount();
  }
  ensureContentIsArray() {
    if (!Array.isArray(this.content)) this.content = typeof this.content === 'string' ? [{type: 'text', text: this.content}] : [];
    return this.content;
  }
  async addImage(image) {
    if (!String(image).startsWith('data:')) {
      const response = await fetch(image, { cache: 'force-cache' });
      if (!response.ok) throw new Error('Failed to fetch image');
      image = await getBase64Async(await response.blob());
    }
    this.ensureContentIsArray().push({ type: 'image_url', image_url: { url: image, detail: oai_settings.inline_image_quality || 'auto' } });
    await this.recount();
  }
  async getImageTokenCost(image, quality) {
    if (quality === 'low') return Message.tokensPerImage;
    const {width, height} = await getImageSizeFromDataURL(image);
    if (quality === 'auto' && width <= 512 && height <= 512) return Message.tokensPerImage;
    const scale = 768 / Math.min(width, height);
    return 85 + 170 * Math.ceil(Math.round(width * scale) / 512) * Math.ceil(Math.round(height * scale) / 512);
  }
}
function serialize(message) {
  if (!message.content && !message.tool_calls) return [];
  return [{ role: message.role, content: message.content, ...(message.name ? { name: message.name } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}), ...(message.role === 'tool' ? { tool_call_id: message.identifier } : {}),
    ...(message.signature ? { signature: message.signature } : {}), ...(message.reasoning ? { reasoning: message.reasoning } : {}) }];
}
export class MessageCollection {
  collection = [];
  constructor(identifier, ...items) { this.identifier = identifier; for (const item of items) this.add(item); }
  add(item) { if (!(item instanceof Message || item instanceof MessageCollection)) throw new TypeError('Expected Message or MessageCollection'); this.collection.push(item); }
  getCollection() { return this.collection; }
  getItemByIdentifier(identifier) { return this.collection.find(item => item?.identifier === identifier); }
  hasItemWithIdentifier(identifier) { return this.collection.some(item => item?.identifier === identifier); }
  getTokens() { return this.collection.reduce((total, item) => total + item.getTokens(), 0); }
  flatten() { return this.collection.flatMap(item => item instanceof MessageCollection ? item.flatten() : [item]); }
  getChat() { return this.flatten().flatMap(serialize); }
}
export class ChatCompletion {
  tokenBudget = 0; messages = new MessageCollection('root'); loggingEnabled = false; overriddenPrompts = [];
  getMessages() { return this.messages; }
  setTokenBudget(context, response) { this.tokenBudget = context - response; }
  validateMessage(message) { if (!(message instanceof Message)) throw new TypeError('Argument must be an instance of Message'); }
  validateMessageCollection(collection) { if (!(collection instanceof MessageCollection)) throw new TypeError('Argument must be an instance of MessageCollection'); }
  checkTokenBudget(message, identifier) { if (!this.canAfford(message)) throw new TokenBudgetExceededError(identifier); }
  add(collection, position = null) {
    this.validateMessageCollection(collection);
    const replacing = position !== null && position !== -1;
    const old = replacing ? this.messages.collection[position] : undefined;
    const available = this.tokenBudget + (old?.getTokens() || 0);
    if (collection.getTokens() > available) throw new TokenBudgetExceededError(collection.identifier);
    if (replacing) this.messages.collection[position] = collection; else this.messages.add(collection);
    this.tokenBudget = available - collection.getTokens();
    return this;
  }
  findMessageIndex(identifier) {
    const index = this.messages.collection.findIndex(item => item?.identifier === identifier);
    if (index < 0) throw new IdentifierNotFoundError(identifier);
    return index;
  }
  insertAtStart(message, identifier) { this.insert(message, identifier, 'start'); }
  insertAtEnd(message, identifier) { this.insert(message, identifier, 'end'); }
  insert(message, identifier, position = 'end') {
    this.validateMessage(message); this.checkTokenBudget(message, message.identifier);
    const target = this.messages.collection[this.findMessageIndex(identifier)];
    this.validateMessageCollection(target);
    if (!message.content && !message.tool_calls) return;
    if (position === 'start') target.collection.unshift(message);
    else if (position === 'end') target.collection.push(message);
    else if (Number.isInteger(position)) target.collection.splice(position, 0, message);
    else throw new TypeError('Invalid insertion position');
    this.decreaseTokenBudgetBy(message.getTokens());
  }
  removeLastFrom(identifier) { const item = this.messages.collection[this.findMessageIndex(identifier)].collection.pop(); if (item) this.freeBudget(item); }
  canAfford(message) { return message.getTokens() <= this.tokenBudget; }
  canAffordAll(messages) { return messages.reduce((total, message) => total + message.getTokens(), 0) <= this.tokenBudget; }
  has(identifier) { return this.messages.hasItemWithIdentifier(identifier); }
  getTotalTokenCount() { return this.messages.getTokens(); }
  getChat() { return this.messages.getChat(); }
  reserveBudget(message) { this.decreaseTokenBudgetBy(typeof message === 'number' ? message : message.getTokens()); }
  freeBudget(message) { this.increaseTokenBudgetBy(message.getTokens()); }
  increaseTokenBudgetBy(tokens) { this.tokenBudget += tokens; }
  decreaseTokenBudgetBy(tokens) { this.tokenBudget -= tokens; }
  setOverriddenPrompts(list) { this.overriddenPrompts = list; }
  getOverriddenPrompts() { return this.overriddenPrompts; }
  enableLogging() { this.loggingEnabled = true; }
  disableLogging() { this.loggingEnabled = false; }
  log(output) { if (this.loggingEnabled) console.log('[ChatCompletion] ' + output); }
  async squashSystemMessages() {
    const before = this.getTotalTokenCount(), result = [];
    const mergeable = message => message.role === 'system' && !message.name && !message.tool_calls && typeof message.content === 'string' && !['newMainChat','newChat','groupNudge'].includes(message.identifier);
    for (const message of this.messages.flatten()) {
      if (message.role === 'system' && !message.content && !message.tool_calls) continue;
      const previous = result.at(-1);
      if (previous && mergeable(previous) && mergeable(message)) {
        // Build first, then commit: a tokenizer error must not half-merge chat.
        const merged = await Message.createAsync(previous.role, previous.content + '\n' + message.content, previous.identifier);
        result[result.length - 1] = merged;
      } else result.push(message);
    }
    this.messages.collection = result;
    this.tokenBudget += before - this.getTotalTokenCount();
  }
}
`;

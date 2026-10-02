import assert from 'node:assert/strict';
import { createServer } from 'node:http';

async function browserChecks() {
  const { Prompt, PromptCollection } = await import('/scripts/PromptManager.js');
  const { Message, MessageCollection, ChatCompletion } = await import('/scripts/openai.js');
  const { getTokenCountAsync, countTokensOpenAIAsync } = await import('/scripts/tokenizers.js');
  const core = await import('/script.js');
  const check = (value, message) => { if (!value) throw new Error(message); }, stages = [];
  const first = new Prompt({ identifier: 'first', role: 'system', content: 'Original' });
  const second = new Prompt({ identifier: 'second', role: 'system', content: 'Second' });
  const prompts = new PromptCollection(first, second);
  check(first.injection_order === 100 && first.extension === false && first.injection_trigger.length === 0, 'Prompt defaults');
  check(prompts.get('second') === second && prompts.index('second') === 1 && prompts.has('first') && !prompts.has('missing'), 'Prompt collection identity and lookup');
  let rejected = false; try { prompts.add({identifier:'invalid'}); } catch { rejected = true; }
  check(rejected && prompts.collection.length === 2, 'Reject non-Prompt without mutation');
  const override = new Prompt({identifier: 'first', role:'system', content:'Overridden {{char}}'});
  prompts.override(override, 0); check(prompts.collection[0] === override && prompts.overriddenPrompts[0] === 'first', 'Override replaces and records');
  stages.push('prompt-defaults-live-identity-overrides-and-type-validation');

  check(await getTokenCountAsync('hello') === 7 && await getTokenCountAsync('hello', 100) === 7 && await getTokenCountAsync('') === 0, 'Tavern chat count framing and padding semantics');
  check(await countTokensOpenAIAsync({role:'user', content:'hello'}) === 6, 'BPE message count');
  check(await countTokensOpenAIAsync({role:'user', content:'お誕生日おめでとう'}) === 14, 'Unicode BPE message count');
  const message = await Message.createAsync('user', 'hello', 'user');
  check(message.getTokens() === 6, 'Message uses real tokenizer');
  await message.setName('Alice'); check(message.getTokens() === 8, 'Name changes recount message');
  stages.push('real-bpe-counts-unicode-message-overhead-and-name-recount');

  const completion = new ChatCompletion(); completion.setTokenBudget(30, 10);
  const empty = new MessageCollection('history'); completion.add(empty, 3);
  completion.reserveBudget(message); check(completion.tokenBudget === 12, 'Reserve tokens'); completion.freeBudget(message);
  completion.insertAtStart(message, 'history'); check(completion.tokenBudget === 12 && completion.has('history'), 'Insertion uses budget');
  const tooLarge = await Message.createAsync('assistant', 'extra '.repeat(60), 'large');
  const previous = JSON.stringify(completion.getChat());
  let budgetError = ''; try { completion.insertAtEnd(tooLarge, 'history'); } catch(error) { budgetError = error.name; }
  check(budgetError === 'TokenBudgetExceeded' && completion.tokenBudget === 12 && JSON.stringify(completion.getChat()) === previous, 'Over-budget insert is atomic');
  let missing = ''; try { completion.insertAtEnd(message, 'missing'); } catch(error) { missing = error.name; }
  check(missing === 'IdentifierNotFoundError' && completion.tokenBudget === 12, 'Missing collection leaves budget intact');
  completion.removeLastFrom('history'); check(completion.tokenBudget === 20 && completion.getTotalTokenCount() === 0, 'Remove refunds tokens');
  completion.insert(message, 'history', 0); check(completion.getMessages().getItemByIdentifier('history') === empty, 'Actual collection remains shared');
  stages.push('token-reservation-insertion-overflow-and-removal-refund');

  const replacement = new MessageCollection('replacement', message);
  completion.add(replacement, 3); check(completion.tokenBudget === 12, 'Replacing occupied slot refunds old collection');
  check(completion.canAffordAll([message]) && !completion.canAffordAll([message, message]), 'Collective affordability');
  completion.setOverriddenPrompts(prompts.overriddenPrompts); check(completion.getOverriddenPrompts()[0] === 'first', 'Overrides remain available');
  const assembled = new ChatCompletion(); assembled.setTokenBudget(300, 20);
  const systemMessages = await Promise.all(prompts.collection.map(prompt => Message.fromPromptAsync(prompt)));
  assembled.add(new MessageCollection('systems', ...systemMessages), 0);
  assembled.add(new MessageCollection('history', message), 2);
  const beforeSquash = assembled.getTotalTokenCount() + assembled.tokenBudget;
  const realFetch = window.fetch;
  window.fetch = (...args) => String(args[0]).includes('/api/extensions/token-count') ? Promise.resolve(new Response('{"error":{"message":"Token fixture error"}}', {status:503})) : realFetch(...args);
  const beforeFailure = JSON.stringify(assembled.getChat()); let failed = false;
  try { await assembled.squashSystemMessages(); } catch { failed = true; } finally { window.fetch = realFetch; }
  check(failed && JSON.stringify(assembled.getChat()) === beforeFailure && assembled.getTotalTokenCount() + assembled.tokenBudget === beforeSquash, 'Failed squash is atomic');
  await assembled.squashSystemMessages();
  check(assembled.getChat().length === 2 && assembled.getChat()[0].content === 'Overridden {{char}}\nSecond', 'Consecutive system prompts merge');
  check(assembled.getTotalTokenCount() + assembled.tokenBudget === beforeSquash, 'Squash refunds frame overhead');
  stages.push('position-replacement-and-system-squash-preserve-budget-and-failure-atomicity');

  const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const image = canvas.toDataURL();
  const media = await Message.createAsync('user', 'Look {{char}}', 'media');
  await media.addImage(image);
  check(media.content[1].image_url.url === image && media.tokens > 85 && await media.getImageTokenCost(image, 'low') === 85, 'Image content and cost');
  const calls = await Message.createAsync('assistant', null, 'tool-source');
  await calls.setToolCalls([{id:'call1', name:'weather', parameters:'{"city":"上海"}', signature:'sig', reasoning:'Tool reason'}], true, true);
  const answer = await Message.createAsync('tool', '晴', 'call1');
  const nested = new MessageCollection('nested', new MessageCollection('inside', media, calls, answer));
  const serialized = nested.getChat();
  check(nested.flatten().length === 3 && serialized[1].tool_calls[0].function.arguments === '{"city":"上海"}' && serialized[1].content === null && serialized[1].reasoning === 'Tool reason' && serialized[2].tool_call_id === 'call1', 'Nested collections and tool data survive serialization');
  stages.push('nested-message-collections-image-costs-and-tool-call-serialization');

  // The generated collection becomes the actual provider request; no fake
  // PromptManager or transport is substituted for this assertion.
  const chatSnapshot = JSON.stringify(core.chat);
  const payload = [...assembled.getChat(), ...serialized];
  const payloadBefore = JSON.stringify(payload);
  const response = await core.generateRaw({prompt:payload, trimNames:false});
  check(response === 'Collection reply', 'Provider result');
  check(JSON.stringify(payload) === payloadBefore && JSON.stringify(core.chat) === chatSnapshot, 'Assembling/sending leaves source prompts and conversation unchanged');
  stages.push('assembled-collections-reach-actual-provider-without-mutating-source-or-chat');

  const openai = await import('/scripts/openai.js');
  const [prepared] = await openai.prepareOpenAIMessages({
    name2: core.name2, charDescription: 'Prompt fixture role', charPersonality: '', Scenario: 'Prompt fixture scenario',
    worldInfoBefore: 'Prompt fixture world', worldInfoAfter: '', systemPromptOverride: 'Prompt fixture system',
    personaDescription: '', extensionPrompts: [], messages: [{role:'user',content:'Prompt fixture input'}], messageExamples:[], type:'normal',
  }, false);
  check(openai.promptManager.render && openai.promptManager.renderDebounced &&
    openai.setupChatCompletionPromptManager(openai.oai_settings) === openai.promptManager,
    'Prompt manager is available at import time and retains one instance');
  check(openai.promptManager.messages?.getChat()?.length === prepared.length &&
    document.querySelector('#mycompanion-prompt-manager pre')?.textContent.includes('Prompt fixture world'),
    'Prompt manager displays actual prepared messages');
  const helperResult = await openai.sendOpenAIRequest('quiet',prepared);
  check(helperResult.choices?.[0]?.message?.content === 'Collection reply', 'Prepared helper prompt reaches provider');
  stages.push('shared-native-assembly-populates-live-prompt-manager-and-provider-request');
  return {stages, expectedCharacter: core.name2, image};
}

export async function verifyPluginPromptCollections(window, service) {
  const requests = [];
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw)); response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({choices:[{message:{content:'Collection reply'}}]}));
  });
  await new Promise(resolve => model.listen(0,'127.0.0.1',resolve));
  try {
    const configured = await service.inject({method:'PUT',url:'/api/settings/provider',payload:{kind:'ollama',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'gpt-4',maxTokens:100}});
    assert.equal(configured.statusCode,200);
    const report = await window.webContents.executeJavaScript(`(${browserChecks.toString()})()`);
    assert.equal(requests.length,2);
    const messages = requests[0].messages;
    assert.deepEqual(messages.map(message => message.role), ['system','user','user','assistant','tool']);
    assert.equal(messages[0].content, `Overridden ${report.expectedCharacter}\nSecond`);
    assert.equal(messages[2].content[0].text, `Look ${report.expectedCharacter}`);
    assert.equal(messages[2].content[1].image_url.url, report.image);
    assert.equal(messages[3].content, null); assert.equal(messages[3].tool_calls[0].signature,'sig'); assert.equal(messages[4].tool_call_id,'call1');
    assert(requests[1].messages.some(message => message.content?.includes?.('Prompt fixture role')));
    assert(requests[1].messages.some(message => message.content === 'Prompt fixture input'));
    return {stages:report.stages,passed:true};
  } finally { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
}

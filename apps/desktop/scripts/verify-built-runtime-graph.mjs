// Validate the served modules after esbuild bundling, where generated function
// strings can differ from the unbundled service checked by workspace tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { startIndependentService } from '../dist/independent-service.js';

const project = fileURLToPath(new URL('../../../', import.meta.url));
const dataRoot = await mkdtemp(join(tmpdir(), 'mycompanion-built-graph-'));
const report = { passed: false, kind: 'actual-bundled-service-served-module-syntax', modules: [],
  boundaries: ['Syntax and literal same-origin module graph only; not browser execution, extension or real secret-storage acceptance'] };
let service;
try {
  service = await startIndependentService({ dataRoot, rendererRoot: resolve(project, 'apps/renderer/dist'),
    storage: { isEncryptionAvailable: () => true, encryptString: () => { throw new Error('No credentials in syntax verification'); },
      decryptString: () => { throw new Error('No credentials in syntax verification'); } } });
  const pending = ['/script.js', '/plugin-runtime/desktop-host.js', '/plugin-runtime/compat-runtime.js'];
  const visited = new Set();
  while (pending.length) {
    const path = pending.shift(); if (visited.has(path)) continue; visited.add(path);
    assert(visited.size <= 256, 'Unexpected generated module graph size');
    const response = await fetch(service.origin + path, { signal: AbortSignal.timeout(10000) });
    assert(response.ok, 'Bundled runtime module HTTP ' + response.status + ': ' + path);
    const source = await response.text();
    const entry = { path, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') };
    report.modules.push(entry);
    let tree;
    try { tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
    catch (error) { throw new Error('Invalid bundled runtime module ' + path + ': ' + error.message); }
    if (path === '/plugin-runtime/prompt-manager-core.js') {
      // This pure module has no DOM or external imports. Execute its actual
      // served bytes too, so an export-name fix cannot hide broken references.
      const core = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
      const prompt = new core.Prompt({ identifier: 'bundled-probe', role: 'system', content: 'PUBLIC_PROBE' });
      const collection = new core.PromptCollection(prompt);
      assert.equal(collection.get('bundled-probe'), prompt);
      const manager = new core.PromptManager(core.readPromptManagerSettings({}), value => value);
      const assembled = core.prepareCompletionPrompts(manager, { charDescription: 'PUBLIC_DESCRIPTION', charPersonality: '',
        scenario: '', worldInfoBefore: '', worldInfoAfter: '', personaDescription: '', quietPrompt: '', bias: '',
        systemPromptOverride: '', jailbreakPromptOverride: '', extensions: [] }, 'normal');
      assert(assembled instanceof core.PromptCollection);
      assert(assembled.collection.length > 0 && assembled.collection.every(item => item instanceof core.Prompt));
      assert.equal(core.parseCompletionExample('<START>\nUser: hello', 'User', 'Character')[0]?.content, 'hello');
      entry.executedClassIdentityAndPromptAssembly = true;
    }
    const imports = [];
    if (path === '/plugin-runtime/chat-merge.js') {
      // Stringified helpers must execute without imported source closures after
      // bundling. Syntax alone cannot detect a missing runtime binding.
      const core = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
      const metadata = { model: 'public-graph-fixture', temperature: 0, maxTokens: 16,
        responseState: { protocol: 'openai', reasoning: 'public reasoning', signature: '', media: [], toolCalls: [], providerContent: [] } };
      const projected = core.toExtensionMessage({ id: 'public-message', content: 'public text', role: 'assistant',
        createdAt: '2026-10-03T00:00:00.000Z', status: 'complete', generationMetadata: metadata,
        extensionData: { generationMetadata: { model: 'extension-shadow' }, future: { retained: true } } }, 'Public character');
      assert.deepEqual(projected.generationMetadata, metadata);
      assert.deepEqual(projected.future, { retained: true });
      projected.generationMetadata.model = 'changed projection';
      assert.equal(metadata.model, 'public-graph-fixture', 'Browser generation projection must not mutate its native input');
      entry.executedSelfContainedChatProjection = true;
    }
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)
        && typeof node.source?.value === 'string') imports.push(node.source.value);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(tree);
    for (const specifier of imports) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      const url = new URL(specifier, service.origin + path);
      if (url.origin === service.origin) pending.push(url.pathname + url.search);
    }
  }
  report.passed = true;
  console.log('Bundled runtime syntax verified: ' + report.modules.length + ' actual HTTP modules.');
} catch (error) { report.error = String(error?.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally {
  await service?.stop();
  await writeFile(join(dataRoot, 'runtime-graph-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('Bundled runtime syntax report: ' + join(dataRoot, 'runtime-graph-report.json'));
}

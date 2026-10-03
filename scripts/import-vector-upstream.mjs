// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'acorn';
const { values } = parseArgs({ options: { 'vectra-dir': { type:'string' }, 'upstream-dir': { type:'string' } } });
const vectraCommit = 'dec2dadc3bb158b06ac72fa9097bee729429a271';
const stCommit = '7e8663cd9c184a550b37238218bdd32c6efc68e9';
const vectraDir = resolve(values['vectra-dir'] ?? `.cache/research/vectra-${vectraCommit}`);
const stDir = resolve(values['upstream-dir'] ?? `.cache/research/SillyTavern-${stCommit}`);
const hash = value => createHash('sha256').update(value).digest('hex');
const metric = readFileSync(resolve(vectraDir,'ItemSelector.ts'),'utf8');
const license = readFileSync(resolve(vectraDir,'LICENSE'),'utf8');
if (hash(metric) !== 'fe5f4d58b34b5c7c0f734c1e58580d574c0de43cf9bd6498889c280bf1f79bd8'
 || hash(license) !== 'e9a3b46a68e82bcd41fe15bfecc3a353b126e7f9cd06a766ae4fde39e0d6d1f9') throw new Error('Vectra input differs from pinned source');
const members = ['normalize','normalizedCosineSimilarity','dotProduct'].map(name => {
  // Only the checksum-fixed declarations below are extracted. Their bodies
  // contain no brace-bearing literals, templates or comments.
  const anchor = new RegExp(`  (?:public|private) static ${name}\\(`).exec(metric);
  if (!anchor) throw new Error('Missing Vectra method: '+name);
  const body = metric.indexOf('{',anchor.index); let depth=1, end=body+1;
  while (end<metric.length && depth) { if(metric[end]==='{')depth++; else if(metric[end]==='}')depth--; end++; }
  if (depth) throw new Error('Unclosed fixed Vectra declaration');
  return '\n'+metric.slice(anchor.index,end);
});
const metricOutput = `// @ts-nocheck -- checksum-fixed unmodified upstream methods; typed/validated host boundary.
// Copyright (c) 2023-2026 Steven Ickman, MIT; full license in vector-metric-LICENSE.txt.
// Selected unmodified Vectra method declarations; regenerate with scripts/import-vector-upstream.mjs.
// Host checks finite/nonzero/equal dimensions before calling; no metadata/index filesystem is imported.
export class VectraMetric {${members.join('\n')}\n}\n`;
writeFileSync('apps/local-service/src/vector-metric-upstream.ts',metricOutput);
writeFileSync('apps/local-service/src/vector-metric-LICENSE.txt',license);
const inputs = [{ repository:'https://github.com/Stevenic/vectra',commit:vectraCommit,path:'src/ItemSelector.ts',license:'MIT',sha256:hash(metric),licenseSha256:hash(license),
  adaptedPath:'src/vector-metric-upstream.ts',adaptedSha256:hash(metricOutput),adaptations:['Select three unmodified metric methods; rename containing class, omit unrelated metadata and filesystem index.','Require matching dimensions and finite nonzero vectors in the host; do not compare truncated dimensions.'] }];
for (const [file,name] of [['openai-vectors.js','getOpenAIBatchVector'],['ollama-vectors.js','getOllamaBatchVector']]) {
  const source = readFileSync(resolve(stDir,'src/vectors',file),'utf8');
  const expected = file==='openai-vectors.js' ? 'cfae6c8fa604eb7d07a318342dffb91e2c52c341118f90a09d1d9fa92d09a12a'
    : '8916c03d036fa8f60d583f61d1e93edd39b96733cd4dd5bc100d168150efb7aa';
  if(hash(source)!==expected) throw new Error('ST vector source differs from pinned input: '+file);
  const parsed = parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const fn = parsed.body.find(node=>node.type==='ExportNamedDeclaration' && node.declaration?.id?.name===name)?.declaration;
  if (!fn) throw new Error('Missing fixed ST transport: '+name);
  inputs.push({repository:'https://github.com/SillyTavern/SillyTavern',commit:stCommit,path:'src/vectors/'+file,license:'AGPL-3.0-only',sha256:hash(source),
    adaptations:['Reference HTTP request body and indexed-response ordering; existing MyCompanion fetch/credential boundary replaces upstream user secret/extra header lookup.','Ollama proxy path is retained instead of resetting pathname to root; disable redirects; bound response bytes and validate every index/dimension/value.','Provider errors are fixed safe codes, never raw body text or credential-bearing URLs.']});
}
writeFileSync('apps/local-service/vector-upstream.json',JSON.stringify({reviewedAt:new Date().toISOString(),inputs},null,2)+'\n');
console.log(JSON.stringify({metricSha256:hash(metricOutput),inputs},null,2));

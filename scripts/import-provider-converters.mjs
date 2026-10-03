// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'acorn';
const {values} = parseArgs({options:{'upstream-dir':{type:'string'},write:{type:'boolean'}}});
const commit='7e8663cd9c184a550b37238218bdd32c6efc68e9';
const sourcePath=resolve(values['upstream-dir']??`.cache/research/SillyTavern-${commit}`,'src/prompt-converters.js');
const source=readFileSync(sourcePath,'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const expected='eadc6ccd7961273c887c0986c2ed1ffe61e2e7da03f83afeb8ba4dc5a5041a13';
if(hash(source)!==expected)throw new Error('Provider converter input differs from pinned SillyTavern source');
const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
const names=['convertClaudeMessages','convertGooglePrompt','calculateClaudeBudgetTokens','calculateGoogleBudgetTokens'];
const declarations=names.map(name=>{
  const node=ast.body.find(node=>node.type==='ExportNamedDeclaration'&&node.declaration?.id?.name===name);
  if(!node)throw new Error('Missing fixed converter: '+name);
  return {name,source:source.slice(node.start,node.end)};
});
const output=`// @ts-nocheck -- unchanged checksum-fixed upstream declarations; typed host boundary.
// SPDX-License-Identifier: AGPL-3.0-only
// SillyTavern ${commit}, src/prompt-converters.js.
// Regenerate/check with scripts/import-provider-converters.mjs; no upstream service is embedded.
const PROMPT_PLACEHOLDER = "Let's get started.";
const REASONING_EFFORT={auto:'auto',low:'low',medium:'medium',high:'high',min:'min',max:'max'};
const GEMINI_MEDIA_RESOLUTION={low:'media_resolution_low',high:'media_resolution_high'};
const enableThoughtSignatures=true;
const tryParse=value=>{try{return JSON.parse(value);}catch{return null;}};

${declarations.map(value=>value.name==='convertGooglePrompt'?value.source.replace("} else if (part.type === 'tool_call_id') {", "} else if (part.type === 'provider_native') {\n                parts.push(part.part);\n            } else if (part.type === 'tool_call_id') {"):value.source).join('\n\n')}\n`;
const target='apps/local-service/src/provider-converters-upstream.ts';
const provenance={repository:'https://github.com/SillyTavern/SillyTavern',commit,license:'AGPL-3.0-only',
  path:'src/prompt-converters.js',sha256:expected,adaptedPath:'src/provider-converters-upstream.ts',adaptedSha256:hash(output),
  declarations:declarations.map(value=>({name:value.name,sha256:hash(value.source)})),
  adaptations:['Extract four fixed function declarations; replace config/utility imports with pinned default constants and a local parse helper.','Google conversion adds one provider_native branch to replay original signed provider response Parts verbatim; other declaration bodies stay unchanged.','Typed service validates supported media/roles and clones inputs; existing SQLite/safeStorage/fetch/error boundaries replace upstream account service.']};
if(values.write){writeFileSync(target,output);writeFileSync('apps/local-service/provider-converters-upstream.json',JSON.stringify(provenance,null,2)+'\n');}
else if(readFileSync(target,'utf8')!==output)throw new Error('Generated provider converter differs; use --write explicitly');
console.log(JSON.stringify(provenance,null,2));

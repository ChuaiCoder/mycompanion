// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { 'upstream-dir': { type: 'string' }, 'official-dir': { type: 'string' } } });
const commit = '7e8663cd9c184a550b37238218bdd32c6efc68e9';
const officialCommit = '7ebf2fdbb06a36b4f900a8de45480c4a2965df03';
const upstream = resolve(values['upstream-dir'] ?? `.cache/research/SillyTavern-${commit}`);
const official = resolve(values['official-dir'] ?? `.cache/research/backyardai-byaf-${officialCommit}`);
const hash = value => createHash('sha256').update(value).digest('hex');
const original = readFileSync(resolve(upstream, 'src/byaf.js'), 'utf8');
if (hash(original) !== 'dc056d1b7f9d616e08b8b49e3db1150cd824665bd1e041ed79ef86ec417765dc')
  throw new Error('BYAF source differs from pinned SillyTavern commit');
let source = original.replace(/^import .*\r?\n/gm, '');
const change = (before, after) => {
  if (!source.includes(before)) throw new Error('Pinned BYAF adaptation anchor missing: ' + before);
  source = source.replace(before, after);
};
change('const defaultAvatarBuffer = await fsPromises.readFile(DEFAULT_AVATAR_PATH);', 'const defaultAvatarBuffer = Buffer.from(defaultByafPortrait);');
change("const chatStartDate = scenario?.messages?.length == 0 ? new Date().toISOString() : scenario?.messages?.filter(m => 'createdAt' in m)[0].createdAt;", 'const chatStartDate = byafChatStartDate(scenario);');
change('send_date: Number(userMessages[i]?.createdAt),', 'send_date: byafDate(userMessages[i]?.createdAt),');
change('send_date: Number(aiMessage.createdAt),', 'send_date: byafDate(aiMessage.createdAt),');
change('send_date: Number(isUser ? message.createdAt : aiMessage.createdAt),', 'send_date: byafDate(isUser ? message.createdAt : aiMessage.createdAt),');
source = `// @ts-nocheck -- selected fixed-upstream JavaScript; regenerate with scripts/import-byaf-upstream.mjs.
// SillyTavern contributors, AGPL-3.0-only. See ../byaf-upstream.json and project LICENSE.
// Changes: bounded ZIP map reader and own fallback portrait; robust ISO/numeric dates and AI-only chat start.
import path from 'node:path';
import { normalizeZipPath } from './bounded-zip.js';
import { defaultByafPortrait, byafChatStartDate, byafDate } from './character-byaf-utils.js';
const urlJoin = (...parts) => normalizeZipPath(parts.join('/'));
const extractFileFromZipBuffer = async (files, file) => files.get(normalizeZipPath(file));
${source}`;
const schema = readFileSync(resolve(official, 'src/byaf/types/schemas.ts'), 'utf8');
if (hash(schema) !== 'd7c2e1067043e271ed7412acbf563b9d548836bd5a3754ccf2ca9f10d255f096')
  throw new Error('BYAF schema differs from pinned Backyard commit');
const license = readFileSync(resolve(official, 'LICENSE'), 'utf8');
if (hash(license) !== '13b5dbf0183ebb120e3e33cb0c6bd97715061941c0adf360a49a303d7680ab93')
  throw new Error('BYAF license differs from pinned Backyard commit');
const output = 'apps/local-service/src/character-byaf-upstream.ts';
const schemaOutput = 'apps/local-service/src/character-byaf-schemas.ts';
writeFileSync(output, source);
writeFileSync(schemaOutput, `// Backyard AI BYAF schemas, copyright (c) 2025 Ahoy Labs, Inc., MIT.
// Fixed commit ${officialCommit}; unmodified schema definitions; see character-byaf-LICENSE.txt.
${schema}`);
writeFileSync('apps/local-service/src/character-byaf-LICENSE.txt', license);
writeFileSync('apps/local-service/byaf-upstream.json', JSON.stringify({ reviewedAt: new Date().toISOString(),
  adaptedFiles: [output.replace('apps/local-service/', ''), schemaOutput.replace('apps/local-service/', '')],
  inputs: [{ repository: 'https://github.com/SillyTavern/SillyTavern', commit, path: 'src/byaf.js',
    license: 'AGPL-3.0-only', sha256: hash(original), adaptedSha256: hash(source),
    adaptations: ['Read one bounded, CRC-verified ZIP map instead of repeated unbounded extraction.',
      'Own fallback portrait instead of upstream application asset.',
      'Preserve ISO and numeric message dates; handle AI-only/no-message chat start.',
      'Use validated POSIX archive paths; original card and swipe conversion retained.'] },
  { repository: 'https://github.com/backyardai/byaf', commit: officialCommit, path: 'src/byaf/types/schemas.ts',
    license: 'MIT', sha256: hash(schema), adaptations: ['None; validate normalized legacy inputs without using schema-stripped output.'],
    licenseSha256: hash(license) }] }, null, 2) + '\n');
console.log(JSON.stringify({ output, upstreamSha256: hash(original), adaptedSha256: hash(source) }));

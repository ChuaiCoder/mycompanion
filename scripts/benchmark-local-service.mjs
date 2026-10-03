import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { cpus, totalmem, platform, release } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../apps/local-service/dist/app.js';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportStamp = new Date().toISOString().replace(/[^0-9TZ]/g, '');
const reportPath = join(project, '.cache/reports', `service-performance-${reportStamp}.json`);
await mkdir(join(project, '.cache/benchmarks'), { recursive: true });
const profile = await mkdtemp(join(project, '.cache/benchmarks/service-'));
const databasePath = join(profile, 'fixture.sqlite');
const app = buildApp({ databasePath });
const report = { passed: false, serviceThresholdsPassed: false, checkedAt: new Date().toISOString(), profile,
  hardware: { cpu: cpus()[0]?.model, logicalCores: cpus().length, totalRamBytes: totalmem(), os: platform(), release: release(), node: process.version },
  generatedFixture: true, messageCount: 10_000, memoryCount: 10_000, warmupRuns: 5, measuredRuns: 30,
  scope: 'Actual loopback HTTP service, including response decoding; desktop interactivity, fault and security gates are separate.', cases: [] };
const compiledFiles=['app','conversation-routes','runtime-repository','generation-pipeline','memory-engine','semantic-memory','tokenizer-service'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
report.compiledInputHashes=Object.fromEntries(await Promise.all(compiledFiles.map(async name=>[name+'.js',hash(await readFile(join(project,'apps/local-service/dist',name+'.js')))])));
const percentile = (numbers, fraction) => [...numbers].sort((a,b) => a - b)[Math.ceil(numbers.length * fraction) - 1];
let fixtureDb;
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const request = async (path, payload) => {
    const result = await fetch(origin + path, payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert(result.ok, 'Benchmark HTTP failure: ' + result.status); return result.json();
  };
  const card = JSON.parse(await readFile(join(project, 'packages/character-card/fixtures/ccv2-full.json'), 'utf8'));
  const character = await request('/api/characters/import/commit', { filename: 'benchmark-original.json', card });
  const story = await request('/api/conversations', { characterId: character.id });
  fixtureDb = new DatabaseSync(databasePath); fixtureDb.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  const messageInsert = fixtureDb.prepare(`INSERT INTO messages(id,conversation_id,branch_id,parent_message_id,role,content,status,created_at) VALUES(?,?,?,?,?,?,'complete',?)`);
  let parent = story.messages.at(-1)?.id ?? null;
  for (let index = story.messages.length; index < report.messageCount; index++) {
    const id = randomUUID(); messageInsert.run(id, story.id, story.activeBranchId, parent, index % 2 ? 'user' : 'assistant',
      `Original benchmark message ${index}. The traveler crosses the observatory and consults a numbered chart.`, new Date(1_700_000_000_000 + index).toISOString()); parent = id;
  }
  const memoryInsert = fixtureDb.prepare(`INSERT INTO memories(id,conversation_id,character_id,type,content,scope,importance,status,pinned,source_message_ids_json,source_message_fingerprints_json,superseded_by,previous_content,created_at,last_used_at)
    VALUES(?,?,?,'fact',?,'story',3,'active',?,'[]','{}',NULL,NULL,?,NULL)`);
  const visibleMemoryIds=new Set();
  for (let index = 0; index < report.memoryCount; index++) {const id=randomUUID();visibleMemoryIds.add(id);memoryInsert.run(id, story.id, character.id,
    `The original archive marker_${String(index % 100).padStart(3, '0')} describes chart ${index} and its observatory entrance.`, index % 1000 === 0 ? 1 : 0, new Date(1_700_000_000_000 + index).toISOString());
  }
  // Identical keywords in another story are an observable scope boundary;
  // performance is never accepted at the expense of leaking those candidates.
  fixtureDb.exec('COMMIT');
  const otherStory=await request('/api/conversations',{characterId:character.id});
  fixtureDb.exec('BEGIN IMMEDIATE');
  for(let index=0;index<100;index++)memoryInsert.run(randomUUID(),otherStory.id,character.id,'marker_043 PRIVATE_OTHER_STORY',0,new Date().toISOString());
  fixtureDb.exec('COMMIT'); fixtureDb.close(); fixtureDb = undefined;
  for (const item of [
    { name: 'open-full-10000-message-story', limitMs: 500, invoke: () => request('/api/conversations/' + story.id), check: result => assert.equal(result.messages.length, 10_000) },
    { name: 'open-latest100-of10000-message-story', limitMs: 500, invoke: () => request('/api/conversations/' + story.id+'?messageLimit=100'), check: result => {assert.equal(result.messages.length,100);assert.equal(result.messageCount,10_000);assert(result.messages[0].content.includes('message 9900.'));assert(result.messages.at(-1).content.includes('message 9999.'));} },
    { name: 'keyword-retrieval-10000-memories', limitMs: 300, invoke: () => request(`/api/conversations/${story.id}/memories/test`, { input: 'marker_043' }), check: result => { assert.equal(result.results.length, 10_000); assert(result.injectedCount > 0);assert(result.results.every(item=>item.scope==='story'&&visibleMemoryIds.has(item.memoryId)));assert(!JSON.stringify(result).includes('PRIVATE_OTHER_STORY')); } },
  ]) {
    for (let index = 0; index < report.warmupRuns; index++) item.check(await item.invoke());
    const samplesMs = [];
    for (let index = 0; index < report.measuredRuns; index++) {
      const start = performance.now(); const result = await item.invoke(); samplesMs.push(performance.now() - start); item.check(result);
    }
    const p95Ms = percentile(samplesMs, 0.95);
    report.cases.push({ name: item.name, limitMs: item.limitMs, p50Ms: percentile(samplesMs, 0.5), p95Ms, maxMs: Math.max(...samplesMs), samplesMs, passed: p95Ms < item.limitMs });
  }
  for(const [file,sha] of Object.entries(report.compiledInputHashes))assert.equal(hash(await readFile(join(project,'apps/local-service/dist',file))),sha,'Compiled input changed during measurements');
  report.serviceThresholdsPassed = report.cases.every(item => item.passed);
  report.remaining = ['Desktop cached first-interaction p95', 'Failure and security acceptance'];
} catch (error) { report.error = String(error?.stack ?? error); process.exitCode = 1; }
finally {
  fixtureDb?.close(); await app.close(); await mkdir(join(project, '.cache/reports'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('Report: ' + reportPath);
  console.log(JSON.stringify(report, null, 2));
}

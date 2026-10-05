import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateReleaseEvidence } from './release-evidence.mjs';
const manifest = { checksPassed: true, executableSha256: 'exe', sourceSha256: 'source' };
function fixture() {
  return { executableSha256: 'exe', sourceSha256: 'source', criticalDefects: 0, highDefects: 0,
    items: { G04: { status: 'passed', reports: ['quality.json'] }, G05: { status: 'passed', reports: ['people.json'] } },
    memoryQuality: { realModel: true, modelRevision: 'test fixture', runs: 3, recall: 0.85, precision: 0.9, staleInjection: 0.02, scopeLeakage: 0, sourceCompleteness: 1 },
    newcomerQuality: { realHumanParticipants: true, participants: 5, independentCompletions: 4, medianFirstChatSeconds: 300, medianMemoryCorrectionSeconds: 120 },
    securityContact: 'fixture only', distributionPlan: 'fixture only' };
}
test('accepts the exact documented thresholds and rejects a different artifact', () => {
  const data = fixture(); assert.deepEqual(validateReleaseEvidence(manifest, data, ['G04', 'G05']), []);
  data.executableSha256 = 'other'; assert(validateReleaseEvidence(manifest, data, ['G04', 'G05']).length);
});
test('scripted onboarding cannot satisfy the real human gate', () => {
  const data = fixture(); data.newcomerQuality.realHumanParticipants = false;
  assert(validateReleaseEvidence(manifest, data, ['G04', 'G05']).some(text => text.includes('G05')));
});
test('missing numerical evidence cannot pass via undefined comparisons', () => {
  for (const field of ['runs', 'recall', 'precision', 'staleInjection']) {
    const data = fixture(); delete data.memoryQuality[field];
    assert(validateReleaseEvidence(manifest, data, ['G04', 'G05']).some(text => text.includes('G04')));
  }
  for (const field of ['participants', 'independentCompletions', 'medianFirstChatSeconds', 'medianMemoryCorrectionSeconds']) {
    const data = fixture(); delete data.newcomerQuality[field];
    assert(validateReleaseEvidence(manifest, data, ['G04', 'G05']).some(text => text.includes('G05')));
  }
});
test('a non-passing checklist item or high severity defect blocks promotion', () => {
  const data = fixture(); data.items.G04.status = 'partial'; data.highDefects = 1;
  const result = validateReleaseEvidence(manifest, data, ['G04', 'G05']);
  assert(result.some(text => text.includes('G04'))); assert(result.some(text => text.includes('High')));
});
test('a void checklist item needs no evidence but cannot claim a passing status', () => {
  const ids = [{ id: 'G04', void: false }, { id: 'G05', void: false }, { id: 'E01', void: true }];
  const absent = fixture(); assert.deepEqual(validateReleaseEvidence(manifest, absent, ids), []);
  const declared = fixture(); declared.items.E01 = { status: 'void', reports: [] };
  assert.deepEqual(validateReleaseEvidence(manifest, declared, ids), []);
  const stale = fixture(); stale.items.E01 = { status: 'passed', reports: ['stale.json'] };
  const result = validateReleaseEvidence(manifest, stale, ids);
  assert(result.some(text => text.includes('E01') && text.includes('void')), result.join('; '));
});
test('excluding void items does not weaken a real item', () => {
  const data = fixture(); delete data.items.G04;
  const ids = [{ id: 'G04', void: false }, { id: 'G05', void: false }, { id: 'E01', void: true }];
  const result = validateReleaseEvidence(manifest, data, ids);
  assert(result.some(text => text.includes('G04')), result.join('; '));
});


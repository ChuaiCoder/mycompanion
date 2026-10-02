/** Machine-enforced release prerequisites; a script run cannot supply human-test evidence. */
export function validateReleaseEvidence(manifest, acceptance, ids) {
  const problems = [];
  const ratio = value => Number.isFinite(value) && value >= 0 && value <= 1;
  const count = value => Number.isInteger(value) && value >= 0;
  if (!manifest.checksPassed) problems.push('Candidate source checks did not pass');
  if (acceptance.executableSha256 !== manifest.executableSha256 || acceptance.sourceSha256 !== manifest.sourceSha256)
    problems.push('Acceptance evidence belongs to a different executable/source');
  if (acceptance.criticalDefects !== 0 || acceptance.highDefects !== 0) problems.push('Critical/High defect count must be zero');
  for (const id of ids) {
    const item = acceptance.items?.[id];
    if (item?.status !== 'passed' || !Array.isArray(item.reports) || !item.reports.length)
      problems.push(id + ': passing evidence is missing');
  }
  const memory = acceptance.memoryQuality;
  if (!memory || memory.realModel !== true || !memory.modelRevision || !count(memory.runs) || memory.runs < 3
    || !ratio(memory.recall) || memory.recall < 0.85 || !ratio(memory.precision) || memory.precision < 0.90 || !ratio(memory.staleInjection) || memory.staleInjection > 0.02
    || memory.scopeLeakage !== 0 || memory.sourceCompleteness !== 1)
    problems.push('G04: fixed real-model memory quality thresholds are not satisfied');
  const newcomer = acceptance.newcomerQuality;
  if (!newcomer || newcomer.realHumanParticipants !== true || !count(newcomer.participants) || newcomer.participants < 5
    || !count(newcomer.independentCompletions) || newcomer.independentCompletions < 4 || newcomer.independentCompletions > newcomer.participants
    || !Number.isFinite(newcomer.medianFirstChatSeconds) || newcomer.medianFirstChatSeconds < 0 || newcomer.medianFirstChatSeconds > 300
    || !Number.isFinite(newcomer.medianMemoryCorrectionSeconds) || newcomer.medianMemoryCorrectionSeconds < 0 || newcomer.medianMemoryCorrectionSeconds > 120)
    problems.push('G05: real newcomer test thresholds are not satisfied');
  if (!acceptance.securityContact || !acceptance.distributionPlan) problems.push('Security contact and actual signing/distribution plan are required');
  return problems;
}

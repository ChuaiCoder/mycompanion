// Inspect a frozen candidate without launching it or modifying its source archive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import verifyPackage from './verify-package.cjs';

const directory = resolve(process.argv[2]);
const reportPath = resolve(process.argv[3]);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
assert(report.independent && report.passed && report.assertionsPassed);
const executable = join(directory, 'MyCompanion-0.2.1-windows-x64.exe');
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const executableSha256 = hash(await readFile(executable));
assert.equal(executableSha256, report.executableSha256);
await verifyPackage({ appOutDir: join(directory, 'win-unpacked') });
const source = join(directory, 'win-unpacked/resources/source/MyCompanion-source.tar.gz');
const files = execFileSync('tar', ['-tzf', source], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
assert(files.every(file => !file.startsWith('/') && !file.split('/').includes('..')));
assert(!files.some(file => /(?:^|\/)(?:vendor|node_modules|fixtures|data|js-slash-runner)(?:\/|$)|\.(?:exe|sqlite\w*|db|zip)$/i.test(file)));
const differences = [];
for (const file of files) {
  const frozen = execFileSync('tar', ['-xOf', source, file], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const current = await readFile(resolve(file)).catch(() => null);
  if (!current || hash(frozen) !== hash(current)) differences.push({ file, frozenSha256: hash(frozen), currentSha256: current && hash(current) });
}
const manifest = {
  createdAt: new Date().toISOString(), architecture: 'independent-react-fastify-sqlite',
  executable, bytes: (await stat(executable)).size, executableSha256,
  correspondingSourceSha256: hash(await readFile(source)), sourceFileCount: files.length,
  sourceDifferencesAtAudit: differences,
  verificationReport: reportPath, stages: report.stages.length,
  runtimeExceptions: report.runtimeExceptions.length,
  browserErrors: report.browserErrors.length,
  consoleReviewRequired: report.browserErrors.length > 0,
  primitiveChecksPerRun: (report.independentPrimitives ?? []).map(({ phase, stages }) => ({ phase, checks: stages.length })),
  runs: report.runs.map(({ phase, documentReadyMs, engineStoppedMs, allProcessesStoppedMs, stopped }) =>
    ({ phase, documentReadyMs, serviceStoppedMs: engineStoppedMs, allProcessesStoppedMs, stopped })),
  completeHelperCompatibility: false,
  status: 'Internal independent candidate. Functional EXE assertions passed; review captured console errors separately; helper compatibility incomplete; official release unchanged.',
};
assert(/^[a-z0-9-]+$/.test(report.reportLabel), 'Verification report label is required');
await mkdir('.cache/reports', { recursive: true });
await writeFile(`.cache/reports/packaged-${report.reportLabel}-build-manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
// Overridable so tests can point the audit at an unreachable endpoint and assert
// that an incomplete audit blocks the gate instead of reporting success.
const api = process.env.MYCOMPANION_OSV_API ?? 'https://api.osv.dev/v1';

// The lockfile is the reproducible input. Installed extraneous packages are not
// part of this scope. Electron is a dev dependency whose runtime is delivered.
export function productionInventory(lock) {
  assert.equal(lock.lockfileVersion, 3, 'Expected npm lockfile v3');
  const packages = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const marker = path.lastIndexOf('node_modules/');
    if (marker < 0 || entry.link || (entry.dev && path.slice(marker + 13) !== 'electron')) continue;
    const name = entry.name ?? path.slice(marker + 13);
    assert.equal(typeof entry.version, 'string', 'Missing locked version: ' + path);
    assert(name && !name.startsWith('@mycompanion/'), 'Unexpected package identity: ' + path);
    const key = name + '\0' + entry.version;
    const item = packages.get(key) ?? { name, version: entry.version, paths: [], deliveredElectron: name === 'electron' };
    item.paths.push({ path, integrity: entry.integrity ?? null, optional: entry.optional === true });
    packages.set(key, item);
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function batchPage(results, pending) {
  assert(Array.isArray(results) && results.length === pending.length, 'OSV result count does not match query count');
  return results.map((result, index) => {
    assert(result && typeof result === 'object' && !Array.isArray(result), 'Invalid OSV result');
    const vulns = result.vulns ?? [];
    assert(Array.isArray(vulns) && vulns.every(v => v && typeof v.id === 'string' && v.id.length), 'Invalid OSV vulnerability IDs');
    const token = result.next_page_token;
    assert(token === undefined || (typeof token === 'string' && token.length), 'Invalid OSV pagination token');
    return { index: pending[index].index, ids: vulns.map(v => v.id), ...(token ? { token } : {}) };
  });
}

async function run() {
  const reportPath = resolve(process.argv[2] ?? resolve(project, '.cache/reports',
    `production-osv-${new Date().toISOString().replace(/[^0-9]/g, '')}.json`));
  const report = { formatVersion: 1, startedAt: new Date().toISOString(),
    source: api, scope: 'npm lockfile production packages (including optional platforms) and delivered Electron runtime',
    npmAuditSucceeded: false, completed: false, passed: false, requests: [], advisories: [] };
  const request = async (path, body) => {
    const response = await fetch(api + path, { method: body ? 'POST' : 'GET',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const raw = await response.text();
    report.requests.push({ path, ...(body ? { body } : {}), status: response.status, sha256: sha256(raw), raw });
    assert(response.ok, 'OSV HTTP ' + response.status);
    return JSON.parse(raw);
  };
  let exitCode = 2;
  try {
    const bytes = await readFile(resolve(project, 'package-lock.json'));
    report.lockfileSha256 = sha256(bytes);
    report.packages = productionInventory(JSON.parse(bytes.toString('utf8')));
    assert(report.packages.length, 'Production inventory is empty');
    const found = new Map();
    for (let start = 0; start < report.packages.length; start += 100) {
      let pending = report.packages.slice(start, start + 100).map((_, offset) => ({ index: start + offset }));
      const tokens = new Set();
      for (let page = 0; pending.length; page++) {
        assert(page < 100, 'OSV pagination exceeded 100 pages');
        const body = { queries: pending.map(({ index, token }) => ({
          package: { ecosystem: 'npm', name: report.packages[index].name },
          version: report.packages[index].version, ...(token ? { page_token: token } : {}) })) };
        const result = await request('/querybatch', body);
        const pages = batchPage(result.results, pending);
        pending = [];
        for (const item of pages) {
          const ids = found.get(item.index) ?? new Set();
          item.ids.forEach(id => ids.add(id));
          found.set(item.index, ids);
          if (item.token) {
            const key = item.index + '\0' + item.token;
            assert(!tokens.has(key), 'OSV pagination repeated a token');
            tokens.add(key);
            pending.push({ index: item.index, token: item.token });
          }
        }
      }
    }
    const ids = [...new Set([...found.values()].flatMap(set => [...set]))].sort();
    for (const id of ids) {
      const advisory = await request('/vulns/' + encodeURIComponent(id));
      assert.equal(advisory.id, id, 'OSV advisory identity mismatch');
      report.advisories.push(advisory);
    }
    report.findings = [...found].filter(([, ids]) => ids.size).map(([index, ids]) => ({
      name: report.packages[index].name, version: report.packages[index].version,
      advisoryIds: [...ids].sort() }));
    report.activeAdvisoryCount = report.advisories.filter(a => !a.withdrawn).length;
    report.completed = true;
    report.passed = report.activeAdvisoryCount === 0;
    exitCode = report.passed ? 0 : 1;
  } catch (error) {
    report.error = { name: error.name, message: error.message, ...(error.cause ? { cause: String(error.cause.message ?? error.cause) } : {}) };
    // An incomplete audit must block the release gate. Leaving the exit code at
    // zero would let `npm run check` report success while the dependency audit
    // never actually happened — a network failure would read as "no advisories".
    report.completed = false;
    report.passed = false;
    exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ reportPath, completed: report.completed, passed: report.passed,
      packageCount: report.packages?.length, activeAdvisoryCount: report.activeAdvisoryCount,
      findings: report.findings, error: report.error }, null, 2));
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();

// Inventory original helper imports against our own service, never the Tavern engine.
// Export presence is a linking check, not evidence that an API's behavior works.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { buildApp } from '../../local-service/dist/app.js';

const flag = process.argv.indexOf('--helper');
assert(flag >= 0 && process.argv[flag + 1], 'Pass --helper <separately obtained original helper>');
const helper = resolve(process.argv[flag + 1]);
const manifest = JSON.parse(await readFile(join(helper, 'manifest.json'), 'utf8'));
const prefix = '/scripts/extensions/third-party/independent-audit/';
const origin = 'http://127.0.0.1';
const visited = new Set(), modules = new Map(), remote = new Set(), dynamic = [];
const service = buildApp();
const report = { architecture: 'independent-react-fastify-sqlite', helperVersion: manifest.version,
  helperEntrySha256: '', completeCompatibility: false, linkingPassed: false, modules: [], remote: [], dynamic: [] };
await init;

function names(source, entry) {
  if (entry.d >= 0) return [];
  const statement = source.slice(entry.ss, entry.se);
  const named = statement.match(/\{([^}]*)\}/)?.[1]?.split(',').map(value => value.trim().split(/\s+as\s+/)[0]).filter(Boolean) ?? [];
  if (/^import\s+[\w$]+(?:\s*,|\s+from\b)/.test(statement)) named.push('default');
  return named;
}

async function inspectFile(url) {
  if (visited.has(url)) return;
  visited.add(url);
  const file = resolve(helper, decodeURIComponent(url.slice(prefix.length)));
  assert(file.startsWith(helper + sep), 'Helper module escaped the supplied checkout');
  const source = await readFile(file, 'utf8');
  if (url === prefix + manifest.js) report.helperEntrySha256 = createHash('sha256').update(source).digest('hex');
  const [imports] = parse(source);
  for (const entry of imports) {
    if (entry.d === -2) continue; // import.meta
    if (!entry.n) { dynamic.push({ file: url, expression: source.slice(entry.ss, entry.se) }); continue; }
    const target = new URL(entry.n, origin + url);
    if (target.origin !== origin) { remote.add(target.href); continue; }
    if (target.pathname.startsWith(prefix)) { await inspectFile(target.pathname); continue; }
    const record = modules.get(target.pathname) ?? { path: target.pathname, imports: new Set(), importers: new Set() };
    for (const name of names(source, entry)) record.imports.add(name);
    record.importers.add(url);
    modules.set(target.pathname, record);
  }
}

try {
  await inspectFile(prefix + manifest.js);
  for (const record of modules.values()) {
    const response = await service.inject({ method: 'GET', url: record.path });
    let declared = [];
    if (response.statusCode === 200 && /javascript/.test(response.headers['content-type'] ?? '')) {
      declared = parse(response.body)[1].map(item => item.n);
    }
    report.modules.push({ path: record.path, status: response.statusCode, imports: [...record.imports].sort(),
      declaredExports: declared.sort(), missingExports: [...record.imports].filter(name => !declared.includes(name)).sort(),
      importers: [...record.importers] });
  }
  report.remote = [...remote]; report.dynamic = dynamic;
  report.localHelperFilesInspected = visited.size;
  report.requiredModules = report.modules.length;
  report.missingModules = report.modules.filter(item => item.status !== 200).length;
  report.missingExportsInServedModules = report.modules.filter(item => item.status === 200).reduce((n, item) => n + item.missingExports.length, 0);
  report.linkingPassed = report.missingModules === 0 && report.missingExportsInServedModules === 0;
} finally {
  await service.close();
  await mkdir('.cache/reports', { recursive: true });
  await writeFile('.cache/reports/independent-helper-import-audit.json', JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ ...report, modules: undefined, remote: undefined, dynamic: undefined }));
if (!report.linkingPassed) process.exitCode = 1;

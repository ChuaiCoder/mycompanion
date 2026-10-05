import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = resolve(process.argv[2] ?? resolve(root, '.cache/reports', `image-header-security-${Date.now()}.json`));
const modulePath = resolve(root, 'apps/local-service/dist/tokens/image-token-cost.js');
const report = { checkedAt: new Date().toISOString(), passed: false, scope: 'Real compiled Token header boundary in an isolated Node child with a hard process timeout', errors: [] };
try {
  report.moduleSha256 = createHash('sha256').update(await readFile(modulePath)).digest('hex');
  report.manifest = JSON.parse(await readFile(resolve(root, 'apps/local-service/image-headers-upstream.json'), 'utf8'));
  const code = `import {imageTokenCost} from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const inputs=[]; const icns=Buffer.alloc(24);icns.write('icns');icns.writeUInt32BE(24,4);icns.write('ic10',8);inputs.push(icns);
    inputs.push(Buffer.from([0,0,0,12,74,88,76,32,13,10,135,10,0,0,0,0,106,120,108,99]));
    const heif=Buffer.alloc(64);heif.writeUInt32BE(24);heif.write('ftypheic',4);heif.write('heicmif1',16);heif.write('meta',28);heif.write('ipco',40);inputs.push(heif);
    let checks=0;for(const mime of ['png','jpeg','webp','gif'])for(const bytes of inputs) {
      const result=imageTokenCost({image_url:{url:'data:image/'+mime+';base64,'+bytes.toString('base64'),detail:'high'}},'gpt-4o');
      if(result.complete||result.reason!=='unknown-image-size')throw new Error('Invalid header was accepted');checks++;
    }console.log(JSON.stringify({checks}));`;
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Image parser child exceeded the 5s deadline')); }, 5000);
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? done(JSON.parse(stdout)) : reject(new Error('Image parser child failed: ' + code + ' ' + stderr)); });
  });
  assert.equal(result.checks, 12); report.checks = result.checks; report.passed = true;
} catch (error) { report.errors.push({ name: error.name, message: error.message }); process.exitCode = 1; }
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ reportPath, passed: report.passed, checks: report.checks, errors: report.errors }));

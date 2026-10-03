import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bindPackagedArtifacts, assertPackagedArtifactsUnchanged } from '../apps/desktop/scripts/packaged-artifact-binding.mjs';
const directories=[];
const digest=text=>createHash('sha256').update(text).digest('hex');
afterEach(async()=>{for(const directory of directories.splice(0)){assert(resolve(directory).startsWith(resolve(join(tmpdir(),'mycompanion-artifact-bind-'))));await rm(directory,{recursive:true,force:true});}});
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'mycompanion-artifact-bind-'));directories.push(directory);const executable=join(directory,'candidate.txt'),source=join(directory,'public-source.txt');await writeFile(executable,'public candidate A');await writeFile(source,'public source A');return{executable,source,argv:['--expected-exe-sha256',digest('public candidate A'),'--source-archive',source,'--expected-source-sha256',digest('public source A')]};}
test('acceptance binds both frozen files and rejects incomplete or mismatched identity before launch',async()=>{const f=await fixture();const identity=await bindPackagedArtifacts(f.argv,f.executable,true);assert.equal(identity.executableSha256,digest('public candidate A'));assert.equal(identity.sourceArchiveSha256,digest('public source A'));await assertPackagedArtifactsUnchanged(identity);await assert.rejects(bindPackagedArtifacts([],f.executable,true),/exact EXE/);await assert.rejects(bindPackagedArtifacts(['--source-archive',f.source],f.executable),/both/);await assert.rejects(bindPackagedArtifacts(['--expected-exe-sha256','f'.repeat(64)],f.executable),/frozen artifact/);});
test('a different candidate cannot inherit the old EXE acceptance',async()=>{const f=await fixture(),identity=await bindPackagedArtifacts(f.argv,f.executable,true);await writeFile(f.executable,'public candidate B');await assert.rejects(assertPackagedArtifactsUnchanged(identity),/EXE changed/);});
test('a changed corresponding source cannot inherit the old source acceptance',async()=>{const f=await fixture(),identity=await bindPackagedArtifacts(f.argv,f.executable,true);await writeFile(f.source,'public source B');await assert.rejects(assertPackagedArtifactsUnchanged(identity),/Source archive changed/);});

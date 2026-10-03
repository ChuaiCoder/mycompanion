// MIT project-owned fixtures; system Git is used by tests, never by the product.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export async function createExtensionHttpFixture() {
  const temporary = await mkdtemp(join(tmpdir(),'mycompanion-extension-http-'));
  const work = join(temporary,'work'), names=['E02-HTTP','e02-http'];
  const requests=[];
  let blocked=false, failedClone=false;
  const git=(args,cwd=temporary)=>{
    const result=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,`git ${args.join(' ')}: ${result.stderr||result.error}`);return result.stdout.trim();
  };
  await mkdir(work);git(['init','-b','main'],work);git(['config','user.name','MyCompanion Test'],work);git(['config','user.email','test@example.invalid'],work);
  for(const name of names){git(['init','--bare',name+'.git']);git(['symbolic-ref','HEAD','refs/heads/main'],join(temporary,name+'.git'));}
  async function publish(version,marker) {
    await writeFile(join(work,'manifest.json'),JSON.stringify({display_name:'E02 HTTP fixture',version,author:'Project fixture',license:'MIT',js:'index.js',css:'index.css',unknownManifest:{keep:17}}));
    await writeFile(join(work,'index.js'),`globalThis.__e02HttpFixture = ${JSON.stringify(marker)};\n`);
    await writeFile(join(work,'index.css'),'#plugin-root { --e02-http-fixture: 1; }\n');
    git(['add','.'],work);git(['commit','-m',version],work);
    for(const name of names)git(['push',join(temporary,name+'.git'),'main'],work);
    return git(['rev-parse','HEAD'],work);
  }
  const firstRevision=await publish('1.0.0','one');
  const server=createServer((request,response)=>{
    const url=new URL(request.url||'/','http://localhost');
    const record={method:request.method,path:url.pathname,query:url.search,status:null};requests.push(record);
    if(blocked||(failedClone&&request.method==='POST')){record.status=503;response.writeHead(503);response.end('Controlled fixture download failure');request.resume();return;}
    const child=spawn('git',['http-backend'],{windowsHide:true,env:{...process.env,GIT_PROJECT_ROOT:temporary,GIT_HTTP_EXPORT_ALL:'1',
      PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:request.method||'GET',CONTENT_TYPE:request.headers['content-type']||'',
      CONTENT_LENGTH:request.headers['content-length']||'',SERVER_PROTOCOL:'HTTP/1.1'}});
    request.pipe(child.stdin);const parts=[];child.stdout.on('data',part=>parts.push(part));
    child.on('error',error=>{record.status=500;response.writeHead(500);response.end(String(error));});
    child.on('close',code=>{
      if(response.writableEnded)return;
      const output=Buffer.concat(parts),separator=output.indexOf('\r\n\r\n'),boundary=separator>=0?separator:output.indexOf('\n\n');
      if(code!==0||boundary<0){record.status=500;response.writeHead(500);response.end('Invalid Git fixture response');return;}
      const headers={},lines=output.subarray(0,boundary).toString('utf8').split(/\r?\n/);let status=200;
      for(const line of lines){const index=line.indexOf(':');if(index<0)continue;const key=line.slice(0,index).trim(),value=line.slice(index+1).trim();
        if(key.toLowerCase()==='status')status=Number(value.slice(0,3));else headers[key]=value;}
      record.status=status;response.writeHead(status,headers);response.end(output.subarray(boundary+(separator>=0?4:2)));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {firstRevision,requests,publish,url:(name=names[0])=>`${origin}/${encodeURIComponent(name)}.git`,
    block:value=>{blocked=value;},failClone:value=>{failedClone=value;},
    close:async()=>{
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      assert.equal(dirname(resolve(temporary)),resolve(tmpdir()));assert(basename(temporary).startsWith('mycompanion-extension-http-'));
      await rm(temporary,{recursive:true,force:true});
    }};
}

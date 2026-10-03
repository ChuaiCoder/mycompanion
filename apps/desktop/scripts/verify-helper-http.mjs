import assert from 'node:assert/strict';
import { createExtensionHttpFixture } from './extension-http-fixture.mjs';

// Executes public APIs from the cached, untouched Helper. No Helper source is
// copied or modified; all repositories and imported chats are project fixtures.
export async function verifyHelperHttp({evaluate,restart,sourceElectronOnly=true}) {
  const fixture=await createExtensionHttpFixture();
  const report={passed:false,completeE02:false,sourceElectronOnly,stages:[],gitRequests:fixture.requests,
    boundaries:['JSON/group chat formats and multi-user profiles are not covered','Original helper reinstall deletes first; a failed subsequent install is not a host transaction']};
  const stage=(name,evidence)=>{report.stages.push({name,evidence});console.log('Passed: '+name);};
  const run=source=>evaluate(`(async()=>{const helper=window.TavernHelper,core=await import('/script.js'),host=await import('/plugin-runtime/desktop-host.js');
    const check=(condition,label)=>{if(!condition)throw new Error(label);};${source}})()`);
  try {
    stage('original-case-helper-self-identity-and-non-git-version',await run(`
      const id=helper.getTavernHelperExtensionId();check(id==='JS-Slash-Runner'&&helper.isInstalledExtension(id),'Original helper self identity');
      check(helper.getExtensionType(id)==='local'&&helper.isAdmin(),'Local identity and desktop admin');
      const info=await helper.getExtensionStatus(id);check(info.current_commit_hash===''&&info.is_up_to_date,'Non-Git version original response');return {id,info};`));
    stage('original-helper-global-url-install-real-git-and-duplicate',await run(`
      const response=await helper.installExtension(${JSON.stringify(fixture.url())},'global'),installed=await response.json();
      check(response.status===200&&installed.folderName==='E02-HTTP','Original global Git install');
      const duplicate=await helper.installExtension(${JSON.stringify(fixture.url())},'global');check(duplicate.status===409,'Same-scope duplicate');return {installed,status:response.status,duplicate:duplicate.status};`));
    await restart();
    stage('global-original-case-installation-info-full-hash-and-live-css-js',await run(`
      check(helper.getExtensionType('E02-HTTP')==='global','Actual original case/global discovery');
      const info=await helper.getExtensionStatus('E02-HTTP');check(info.current_commit_hash===${JSON.stringify(fixture.firstRevision)}&&info.is_up_to_date,'Full Git revision');
      const items=await fetch('/api/code-plugins').then(r=>r.json());const p=items.items.find(p=>p.extensionName==='E02-HTTP');window.__e02HttpGlobalId=p.id;
      await fetch('/api/code-plugins/'+p.id+'/enabled',{method:'PUT',headers:core.getRequestHeaders(),body:JSON.stringify({enabled:true})});
      await fetch('/api/code-plugins/'+p.id+'/contributions',{method:'PUT',headers:core.getRequestHeaders(),body:JSON.stringify({systemPrompt:'GLOBAL CONTRIBUTION',commands:[]})});
      const js=await fetch('/scripts/extensions/third-party/E02-HTTP/index.js').then(r=>r.text()),css=await fetch('/scripts/extensions/third-party/E02-HTTP/index.css').then(r=>r.text());
      check(js.includes('"one"')&&css.includes('--e02-http-fixture'),'Original case JS/CSS aliases');return {info,id:p.id,js,css};`));
    const second=await fixture.publish('2.0.0','two');
    stage('original-update-pre-pull-status-assets-and-existing-settings',await run(`
      const before=await fetch('/api/backup').then(r=>r.json());const status=await helper.getExtensionStatus('E02-HTTP');check(!status.is_up_to_date,'Actual remote changed');
      const response=await helper.updateExtension('E02-HTTP'),result=await response.json();check(response.ok&&result.isUpToDate===false&&result.shortCommitHash===${JSON.stringify(second.slice(0,7))},'Actual update/pre-pull status');
      const info=await helper.getExtensionStatus('E02-HTTP');check(info.current_commit_hash===${JSON.stringify(second)},'Updated full hash');
      const after=await fetch('/api/backup').then(r=>r.json()),old=before.codePlugins.find(p=>p.id===window.__e02HttpGlobalId),p=after.codePlugins.find(p=>p.id===window.__e02HttpGlobalId);
      check(p.enabled&&p.installedAt===old.installedAt&&JSON.stringify(p.contributions)===JSON.stringify(old.contributions),'Actual state retained');
      check((await fetch('/scripts/extensions/third-party/E02-HTTP/index.js').then(r=>r.text())).includes('"two"'),'Updated module byte content');return {status,result,info,state:p};`));
    stage('local-global-coexistence-case-distinct-folders',await run(`
      const local=await helper.installExtension(${JSON.stringify(fixture.url())},'local');check(local.ok,'Same URL local/global coexistence');
      const distinct=await helper.installExtension(${JSON.stringify(fixture.url('e02-http'))},'local');check(distinct.ok,'Case-distinct slug collision');
      return {local:await local.json(),caseDistinct:await distinct.json()};`));
    await restart();
    stage('actual-local-discovery-shadows-disabled-global-and-independent-scope-version',await run(`
      check(helper.getExtensionType('E02-HTTP')==='local'&&helper.getExtensionType('e02-http')==='local','Original case-sensitive discovery');
      const items=await fetch('/api/code-plugins').then(r=>r.json());const copies=items.items.filter(p=>p.extensionName==='E02-HTTP');check(copies.length===2&&new Set(copies.map(p=>p.id)).size===2,'Actual distinct records');
      const effective=await fetch('/api/code-plugins/runtime').then(r=>r.json());check(effective.items.filter(p=>p.extensionName==='E02-HTTP').length===1&&effective.items.find(p=>p.extensionName==='E02-HTTP').installationScope==='local','Disabled local shadows global');
      const global=await fetch('/api/extensions/version',{method:'POST',headers:core.getRequestHeaders(),body:JSON.stringify({extensionName:'third-party/E02-HTTP',global:true})}).then(r=>r.json());
      check(global.currentCommitHash===${JSON.stringify(second)},'Explicit global remains accessible');return {copies,effective:effective.items,global};`));
    await fixture.publish('3.0.0','three');fixture.failClone(true);
    stage('real-failed-clone-preserves-old-assets-and-settings',await run(`
      const before=await fetch('/api/backup').then(r=>r.json()),response=await helper.updateExtension('E02-HTTP');check(response.status===500,'Real download failure');
      const after=await fetch('/api/backup').then(r=>r.json());check(JSON.stringify(after.codePlugins)===JSON.stringify(before.codePlugins),'Failed update preserves all installed records');
      check((await fetch('/scripts/extensions/third-party/E02-HTTP/index.js').then(r=>r.text())).includes('"two"'),'Old assets available');return {status:response.status,error:await response.json()};`));
    fixture.failClone(false);
    stage('original-reinstall-delete-install-and-uninstall-local-reveals-global',await run(`
      const response=await helper.reinstallExtension('E02-HTTP');check(response.ok,'Original delete then install');
      check((await fetch('/scripts/extensions/third-party/E02-HTTP/index.js').then(r=>r.text())).includes('"three"'),'Reinstalled new assets');
      const deleted=await helper.uninstallExtension('E02-HTTP');check(deleted.ok,'Original uninstall local');return {reinstall:response.status,deleted:deleted.status};`));
    await restart();
    stage('global-unshadowed-after-full-restart-and-original-up-to-date-reinstall',await run(`
      check(helper.getExtensionType('E02-HTTP')==='global','Global exposed after local deletion');
      const updated=await helper.updateExtension('E02-HTTP');check(updated.ok,'Update remaining global');
      const response=await helper.reinstallExtension('E02-HTTP'),value=await response.json();check(response.status===200&&value.message==='扩展已是最新版本','Original no-op reinstall');
      const missing=await helper.uninstallExtension('missing-extension');check(missing.status===404,'Original missing extension response');return {value,missing:missing.status};`));
    const input=[{user_name:'Raw reader',character_name:'Original raw',create_date:'original date',unknownHeader:{keep:[1,2]},chat_metadata:{variables:{score:7},future:{keep:true}}},
      {name:'Raw reader',is_user:true,mes:{message:'RAW USER'},unknownMessage:{keep:17},extra:{variables:{value:3}}},
      {name:'Original raw',is_user:false,mes:'RAW SECOND',swipes:[{message:'RAW FIRST'},{message:'RAW SECOND'}],swipe_id:1,
        swipe_info:[{extra:{variables:{s:1}}},{extra:{variables:{s:2}}}],extra:{media:{kept:true}}}];
    const jsonl=input.map(value=>JSON.stringify(value)).join('\n')+'\n';
    const imported=await run(`
      const original=core.getCurrentChatId(),before=core.chat.length,response=await helper.importRawChat('E02 raw history',${JSON.stringify(jsonl)}),value=await response.json();
      check(response.ok&&value.res&&value.fileNames.length===1,'Original File/FormData import');
      const avatar=core.characters[core.this_chid].avatar;const history=await fetch('/api/chats/get',{method:'POST',headers:core.getRequestHeaders(),body:JSON.stringify({avatar_url:avatar,file_name:value.fileNames[0]})}).then(r=>r.json());
      check(history[0].unknownHeader.keep[1]===2&&history[0].chat_metadata.variables.score===7,'Raw unknown header/variables');
      check(history[1].mes==='RAW USER'&&history[1].unknownMessage.keep===17&&history[2].swipes[1]==='RAW SECOND'&&history[2].swipe_info[1].extra.variables.s===2,'Chub text, unknown and swipe data');
      check(core.getCurrentChatId()===original&&core.chat.length===before,'Import keeps active story');
      const invalid=await helper.importRawChat('invalid',${JSON.stringify(JSON.stringify(input[0])+'\n{broken')}),error=await invalid.json();check(invalid.ok&&error.error===true,'Original invalid JSONL response');
      const chats=await fetch('/api/characters/chats',{method:'POST',headers:core.getRequestHeaders(),body:JSON.stringify({avatar_url:avatar})}).then(r=>r.json());check(chats.filter(chat=>chat.chat_name==='invalid').length===0,'No partial invalid story');
      return {value,avatar,history,error,current:original};`);
    stage('original-raw-chat-multipart-jsonl-history-and-invalid-atomic-response',imported);
    await restart();
    stage('jsonl-header-swipes-variables-survive-real-service-port-and-window-restart',await run(`
      const history=await fetch('/api/chats/get',{method:'POST',headers:core.getRequestHeaders(),body:JSON.stringify({avatar_url:${JSON.stringify(imported.avatar)},file_name:${JSON.stringify(imported.value.fileNames[0])}})}).then(r=>r.json());
      check(JSON.stringify(history)===${JSON.stringify(JSON.stringify(imported.history))},'Exact imported projection after restart');
      const backup=await fetch('/api/backup').then(r=>r.json()),entry=backup.conversations.find(c=>c.id+'.jsonl'===${JSON.stringify(imported.value.fileNames[0])});
      check(entry.chatHeader.unknownHeader.keep[1]===2&&entry.messages[1].extensionData.swipe_info[1].extra.variables.s===2,'Backup retains raw unknown/swipe fields');
      return {history,chatHeader:entry.chatHeader,scopes:backup.codePlugins.filter(p=>p.extensionName==='E02-HTTP').map(p=>({id:p.id,name:p.extensionName,scope:p.installationScope}))};`));
    assert(fixture.requests.some(request=>request.method==='POST'&&request.status===503));report.passed=true;
  } catch(error) { report.error=error.stack||String(error); }
  finally { await fixture.close(); }
  return report;
}


import assert from 'node:assert/strict';
import {verifyPluginSlash} from './verify-plugin-slash.mjs';

// All calls below go through the byte-unchanged original helper's public API.
export async function verifyHelperSlash(window,service,providerRequests) {
  const stages=[],evaluate=source=>window.webContents.executeJavaScript(source);
  const literalScript='/parser-flag REPLACE_GETVAR | /setvar key=helperLiteral \\{\\{lastMessageId}} | /pass {{getvar::helperLiteral}}';
  const beforeRequests=providerRequests.length;
  const product=await verifyPluginSlash(window,service);
  stages.push(...product.stages);
  await evaluate(`import('/plugin-runtime/desktop-host.js').then(host=>host.start())`);
  const result=await evaluate(`(async()=>{
    const helper=window.TavernHelper;
    if(!helper?.triggerSlash)throw new Error('Original helper triggerSlash is missing');
    const core=await import('/script.js'),power=await import('/scripts/power-user.js');
    const results=[];
    for(const experimental of [false,true]) {
      power.power_user.experimental_macro_engine=experimental;
      results.push({experimental,
        closure:await helper.triggerSlash('/let key=greet {: who=World /pass Hello {{var::who}} :} | /run who=Reader greet'),
        scope:await helper.triggerSlash('/let key=outer outside | /run {: /let key=outer inside | /pass {{var::outer}} :} | /pass {{var::outer}}/{{pipe}}'),
        flow:await helper.triggerSlash('/setvar key=helperCounter 0 | /times 4 {: /incvar helperCounter :} | /getvar helperCounter'),
        immediate:await helper.triggerSlash('/pass {: /pass inner :}()'),
        macro:await helper.triggerSlash(${JSON.stringify(literalScript)})});
    }
    await helper.triggerSlash('/setvar key=helperPersist 19');
    await (await import('/plugin-runtime/desktop-host.js')).flush();
    return {results,story:core.getCurrentChatId(),local:helper.getVariables({type:'chat'})};
  })()`);
  for(const row of result.results)assert.deepEqual(row,{experimental:row.experimental,closure:'Hello Reader',scope:'outside/inside',flow:'4',immediate:'inner',macro:'{{lastMessageId}}'});
  assert.equal(result.local.helperPersist,'19');
  stages.push('untouched-helper-triggerSlash-runs-real-closures-scopes-control-flow-and-both-macro-modes');
  const cancellation=await evaluate(`(async()=>{
    const slash=await import('/scripts/slash-commands.js'),controllers=await import('/scripts/slash-commands/SlashCommandAbortController.js');
    const controller=new controllers.SlashCommandAbortController();
    const pending=slash.executeSlashCommandsWithOptions('/delay 60000 | /setvar key=helperAfter no',{abortController:controller});
    await new Promise(resolve=>setTimeout(resolve,20));controller.abort('fixture-stop',true);
    const result=await pending;
    return {aborted:result.isAborted,reason:result.abortReason,listeners:controller.listeners.abort.length,after:TavernHelper.getVariables({type:'chat'}).helperAfter};
  })()`);
  assert.deepEqual(cancellation,{aborted:true,reason:'fixture-stop',listeners:0,after:undefined});
  stages.push('electron-async-delay-aborts-before-later-variable-write-and-removes-listeners');
  const stored=(await service.inject({url:'/api/conversations/'+result.story})).json();
  assert.equal(stored.chatMetadata.variables.helperPersist,'19');
  assert.equal(providerRequests.length,beforeRequests,'Slash tests must never invoke a model');
  stages.push('helper-slash-writes-real-sqlite-without-a-provider-request');
  return {passed:true,stages,product,result,cancellation,providerRequests:providerRequests.length-beforeRequests};
}

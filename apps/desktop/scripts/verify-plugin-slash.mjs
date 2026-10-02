import assert from 'node:assert/strict';

export async function verifyPluginSlash(window, service) {
  const stages = [];
  const evaluate = source => window.webContents.executeJavaScript(source);
  const wait = async predicate => {
    const end = Date.now() + 10000;
    while (!await predicate()) {
      if (Date.now() > end) throw new Error('Slash verification wait timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const story = await evaluate(`(async () => {
    window.slashCore = await import('/script.js');
    window.slashRuntime = await import('/scripts/slash-commands.js');
    const parser = await import('/scripts/slash-commands/SlashCommandParser.js');
    const commands = await import('/scripts/slash-commands/SlashCommand.js');
    parser.SlashCommandParser.addCommandObject(commands.SlashCommand.fromProps({ name:'triple', aliases:['x3'], splitUnnamedArgument:false,
      callback: (named, unnamed) => String(Number(unnamed) * Number(named.factor || 3)) }));
    const response = await fetch('/api/characters/create', { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ ch_name:'Slash fixture', first_mes:'Opening' }) });
    const avatar = await response.text();
    await slashCore.getCharacters();
    await slashCore.selectCharacterById(slashCore.characters.findIndex(character => character.avatar === avatar));
    return slashCore.getCurrentChatId();
  })()`);
  assert(story);
  const identity=await evaluate(`(async()=>{
    const runtime=await import('/plugin-runtime/scripts/slash-commands.js');
    const canonical=await import('/scripts/slash-commands.js');
    const a=await import('/plugin-runtime/scripts/slash-commands/SlashCommandParser.js');
    const b=await import('/scripts/slash-commands/SlashCommandParser.js');
    return {entry:runtime.executeSlashCommandsWithOptions===canonical.executeSlashCommandsWithOptions,parser:a.SlashCommandParser===b.SlashCommandParser};
  })()`);
  assert.deepEqual(identity,{entry:true,parser:true});stages.push('slash-runtime-and-canonical-aliases-share-one-esm-class-and-registry');
  const before = (await service.inject({ method:'GET', url:'/api/conversations/' + story })).json();
  const piped = await evaluate(`slashRuntime.executeSlashCommandsWithOptions('/x3 factor=4 5 | /echo {{pipe}}')`);
  assert.equal(piped.pipe,'20'); assert.equal(piped.isError,false); assert.equal(piped.isAborted,false);
  const malformed = await evaluate(`import('/plugin-runtime/desktop-host.js').then(host=>host.runSlashCommand('/pass "unclosed'))`);
  assert.equal(malformed.isError, true); assert.match(malformed.errorMessage, /quoted value/);
  stages.push('registered-alias-named-arguments-and-pipe-return-real-results');
  const enums = await evaluate(`(async () => {
    const values = await import('/scripts/slash-commands/SlashCommandEnumValue.js');
    const common = await import('/scripts/slash-commands/SlashCommandCommonEnumsProvider.js');
    return { text: String(new values.SlashCommandEnumValue('bgm', null, values.enumTypes.enum, common.enumIcons.file)),
      boolean: common.commonEnumProviders.boolean('trueFalse')().map(item => item.value),
      icon: common.enumIcons.file };
  })()`);
  assert.deepEqual(enums, { text:'bgm', boolean:['true','false'], icon:'📄' });
  const argumentsResult = await evaluate(`(async () => {
    const args = await import('/scripts/slash-commands/SlashCommandArgument.js');
    const parser = await import('/scripts/slash-commands/SlashCommandParser.js');
    const commands = await import('/scripts/slash-commands/SlashCommand.js');
    parser.SlashCommandParser.addCommandObject(commands.SlashCommand.fromProps({ name:'switchtest',
      namedArgumentList:[new args.SlashCommandNamedArgument('state','state',args.ARGUMENT_TYPE.BOOLEAN,false,false,'true')],
      callback:named=>named.state??'true' }));
    return [(await slashRuntime.executeSlashCommandsWithOptions('/switchtest')).pipe,
      (await slashRuntime.executeSlashCommandsWithOptions('/switchtest state=false')).pipe];
  })()`);
  assert.deepEqual(argumentsResult, ['true','false']);
  stages.push('upstream-enum-and-argument-metadata-with-callback-default-handling');

  const variablePipe = await evaluate(`slashRuntime.executeSlashCommandsWithOptions('/setvar key=first 11 | /setvar key=second {{pipe}} | /getvar key=second')`);
  assert.equal(variablePipe.pipe, '11');
  stages.push('named-arguments-expand-pipe-and-write-shared-story-variables');

  await evaluate(`(() => { $('#send_textarea').val('/setvar key=score 7').trigger('input');
    document.getElementById('send_form').requestSubmit(); })()`);
  await wait(() => evaluate(`document.getElementById('send_textarea').value === ''`));
  const variable = await evaluate(`slashRuntime.executeSlashCommandsWithOptions('/getvar key=score')`);
  assert.equal(variable.pipe, '7');
  const after = (await service.inject({ method:'GET', url:'/api/conversations/' + story })).json();
  assert.deepEqual(after.messages.map(message => [message.id, message.role, message.content]),
    before.messages.map(message => [message.id, message.role, message.content]), 'Slash input must not create a model/chat turn');
  assert.equal(after.chatMetadata.variables.score, '7');
  assert.equal(after.chatMetadata.variables.second, '11');
  stages.push('composer-slash-command-saves-real-chat-variable-without-model-turn');

  await evaluate(`(() => { $('#send_textarea').val('/missing-command').trigger('input');
    document.getElementById('send_form').requestSubmit(); })()`);
  await wait(() => evaluate(`document.body.innerText.includes('Unknown command')`));
  assert.equal(await evaluate(`document.getElementById('send_textarea').value`), '/missing-command');
  assert.deepEqual((await service.inject({ method:'GET', url:'/api/conversations/' + story })).json().messages.map(message => [message.id, message.role, message.content]),
    before.messages.map(message => [message.id, message.role, message.content]));
  stages.push('unknown-command-keeps-draft-and-never-becomes-model-input');

  window.reload();
  await wait(async () => {
    try { return await evaluate(`(async () => {
      const core = await import('/script.js'); const slash = await import('/scripts/slash-commands.js');
      const result = await slash.executeSlashCommandsWithOptions('/getvar key=score');
      return core.getCurrentChatId() === ${JSON.stringify(story)} && result?.pipe === '7';
    })()`); } catch { return false; }
  });
  stages.push('slash-variable-reloads-from-current-story-sqlite-metadata');
  return { passed:true, stages, story };
}

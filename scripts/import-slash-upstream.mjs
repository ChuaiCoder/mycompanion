// Imports selected AGPL-3.0-only execution components from the fixed, reviewed checkout.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseJavaScript } from 'acorn';

const commit = '7e8663cd9c184a550b37238218bdd32c6efc68e9';
const root = resolve(process.argv[2] ?? `.cache/research/SillyTavern-${commit}`);
const target = resolve('apps/local-service/upstream-slash');
mkdirSync(target, { recursive: true });
const entries = [], assets = {};
const hash = value => createHash('sha256').update(value).digest('hex');
const header = `/*! Adapted from SillyTavern 1.19.0, ${commit}. AGPL-3.0-only. See slash-upstream.json and THIRD_PARTY_NOTICES.md. */\n`;
const parse = source => parseJavaScript(source, { ecmaVersion: 'latest', sourceType: 'module' });
const textOf = (source, node) => source.slice(node.start, node.end);
const declaration = node => node.type === 'ExportNamedDeclaration' ? node.declaration : node;
function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, callback));
    else if (value && typeof value === 'object') visit(value, callback);
  }
}
function functionText(source, names) {
  return parse(source).body.map(declaration).filter(node => node?.type === 'FunctionDeclaration' && names.includes(node.id?.name))
    .map(node => `export ${textOf(source, node)}`).join('\n\n');
}
function store(name, upstreamPath, adapted, adaptation) {
  const original = readFileSync(join(root, upstreamPath), 'utf8');
  const content = header + adapted;
  writeFileSync(join(target, name), content);
  entries.push({ path: `upstream-slash/${name}`, upstreamPath, upstreamSha256: hash(original), adaptedSha256: hash(content),
    license: 'AGPL-3.0-only', adaptation });
  assets[`/plugin-runtime/scripts/slash-commands/${name}`] = content;
}

const components = ['AbstractEventTarget','SlashCommandAbortController','SlashCommandBreakController','SlashCommandClosureResult',
  'SlashCommandParserError','SlashCommandExecutionError','SlashCommandNamedArgumentAssignment','SlashCommandUnnamedArgumentAssignment',
  'SlashCommand','SlashCommandArgument','SlashCommandEnumValue','SlashCommandScope','SlashCommandExecutor','SlashCommandBreakPoint',
  'SlashCommandBreak','SlashCommandDebugController','SlashCommandClosure','SlashCommandParser'];
for (const component of components) {
  const upstreamPath = `public/scripts/slash-commands/${component}.js`;
  let source = readFileSync(join(root, upstreamPath), 'utf8');
  let adaptation = 'Unchanged execution component; served under the upstream-compatible module path.';
  if (component === 'SlashCommandParser') {
    const ast = parse(source), edits = [];
    for (const raw of ast.body) {
      const statement = declaration(raw);
      if (raw.type === 'ImportDeclaration' && raw.source.value.includes('AutoComplete')) edits.push([raw.start, raw.end]);
      if (statement?.type === 'ClassDeclaration' && statement.id?.name === component) {
        for (const member of statement.body.body) {
          if (['getNameAt','indexMacros'].includes(member.key?.name)) edits.push([member.start, member.end]);
          else visit(member, node => {
            if (node.type === 'ExpressionStatement' && node.expression?.type === 'CallExpression'
                && node.expression.callee?.object?.type === 'ThisExpression' && node.expression.callee?.property?.name === 'indexMacros') {
              edits.push([node.start, node.end]);
            }
          });
        }
      }
    }
    for (const [start, end] of edits.sort((a,b) => b[0]-a[0])) source = source.slice(0,start) + source.slice(end);
    source = "import { recordSlashCommand } from '/plugin-runtime/compat-runtime.js';\n" + source;
    source = source.replace('this.commands[command.name] = command;', 'this.commands[command.name] = command;\n        recordSlashCommand(command);');
    adaptation = 'Remove editor-only autocomplete imports, getNameAt/indexMacros methods and macro-index collection calls. Parsing, flags, closure/argument grammar and execution metadata retain upstream behavior.';
    adaptation += ' Notify the native contribution registry after registration; no new name restrictions.';
  }
  if (component === 'SlashCommandClosure') {
    source = "import { waitForSlashContinue } from '/plugin-runtime/slash-adapter.js';\n" + source;
    source = source.replace('await delay(200);', 'await waitForSlashContinue(this.abortController);');
    source = source.replace(/( {12}\/\/ resolve args\r?\n {12}step = await stepper.next\(\);)/, '$1\n            if (step.done) break;');
    adaptation = 'Keep the upstream closure execution/argument/scope/macro logic. Replace pause polling with native abort/continue listeners. Preserve a completed executeStep result after argument resolution: upstream discarded a pre-callback abort result by calling next() once more.';
  }
  if(source.includes("from '../utils.js'")) adaptation += ' Redirect utility imports to the extracted fixed-upstream Slash utility module.';
  source = source.replaceAll("from '../utils.js'", "from '/plugin-runtime/slash-utils.js'");
  store(component + '.js', upstreamPath, source, adaptation);
}

const variablesPath = 'public/scripts/variables.js';
const variables = readFileSync(join(root, variablesPath), 'utf8'), variableAst = parse(variables);
const storageNames = new Set(['getLocalVariable','setLocalVariable','getGlobalVariable','setGlobalVariable','addLocalVariable','addGlobalVariable',
  'incrementLocalVariable','incrementGlobalVariable','decrementLocalVariable','decrementGlobalVariable','existsLocalVariable','existsGlobalVariable',
  'deleteLocalVariable','deleteGlobalVariable','resolveVariable','getVariableMacros']);
let variableBody = variableAst.body.filter(raw => raw.type !== 'ImportDeclaration'
  && !(declaration(raw)?.type === 'FunctionDeclaration' && storageNames.has(declaration(raw).id?.name))).map(node => textOf(variables, node)).join('\n');
const variableImports = `import { chat_metadata, getCurrentChatId, saveSettingsDebounced } from '/script.js';
import { extension_settings, saveMetadataDebounced } from '/scripts/extensions.js';
import { executeSlashCommandsWithOptions } from '/scripts/slash-commands.js';
import { getLocalVariable,setLocalVariable,getGlobalVariable,setGlobalVariable,addLocalVariable,addGlobalVariable,
  incrementLocalVariable,incrementGlobalVariable,decrementLocalVariable,decrementGlobalVariable,existsLocalVariable,existsGlobalVariable,
  deleteLocalVariable,deleteGlobalVariable,resolveVariable } from '/plugin-runtime/variables.js';
import { SlashCommand } from './SlashCommand.js';
import { SlashCommandAbortController } from './SlashCommandAbortController.js';
import { ARGUMENT_TYPE,SlashCommandArgument,SlashCommandNamedArgument } from './SlashCommandArgument.js';
import { SlashCommandBreakController } from './SlashCommandBreakController.js';
import { SlashCommandClosure } from './SlashCommandClosure.js';
import { SlashCommandClosureResult } from './SlashCommandClosureResult.js';
import { commonEnumProviders,enumIcons } from './SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue,enumTypes } from './SlashCommandEnumValue.js';
import { SlashCommandParser } from './SlashCommandParser.js';
import { SlashCommandScope } from './SlashCommandScope.js';
import { slashCommandReturnHelper } from './SlashCommandReturnHelper.js';
import { isFalseBoolean,convertValueType,isTrueBoolean } from '/plugin-runtime/slash-utils.js';
`;
store('VariableCommands.js', variablesPath, variableImports + variableBody,
  'Reuse every variable/control-flow/math/closure command and callback; replace original storage functions with existing invocation-aware chat/settings storage adapters. Keep original MAX_LOOPS and guard=off behavior.');

const defaultPath = 'public/scripts/slash-commands.js', defaults = readFileSync(join(root, defaultPath), 'utf8'), defaultAst = parse(defaults);
const neededFunctions = new Set(['runCallback','abortCallback','delayCallback','echoCallback','setInputCallback','getMessagesCallback','trimStartCallback','trimEndCallback']);
const selectedCommands = new Set(['run','abort','delay','pass','echo','upper','lower','substr','replace','test','match','setinput','messages',
  'array-wrap','array-unwrap','trimstart','trimend','stop','chat-reload','forcesave','tokens','input','popup','buttons','inject','listinjects','flushinject']);
const popupFunctionNames = ['inputCallback','popupCallback','buttonsCallback'];
const popupCallbacks = defaultAst.body.map(declaration).filter(node => node?.type === 'FunctionDeclaration' && popupFunctionNames.includes(node.id?.name))
  .map(node => textOf(defaults,node));
if (popupCallbacks.length !== popupFunctionNames.length) throw new Error('Unexpected popup callback selection');
const injectFunctionNames = ['injectCallback','listInjectsCallback','flushInjectsCallback','processChatSlashCommands'];
const injectCallbacks = defaultAst.body.map(declaration).filter(node => node?.type === 'FunctionDeclaration' && injectFunctionNames.includes(node.id?.name))
  .map(node => textOf(defaults,node));
const filterCallback = defaultAst.body.map(declaration).find(node => node?.type === 'FunctionDeclaration' && node.id?.name === 'closureToFilter');
const injectKey = defaultAst.body.map(declaration).find(node => node?.type === 'VariableDeclaration' && node.declarations[0]?.id?.name === 'SCRIPT_PROMPT_KEY');
if (injectCallbacks.length !== injectFunctionNames.length || !filterCallback || !injectKey) throw new Error('Unexpected script injection callback selection');
const registrationName = name => `register_${name.replaceAll('-', '_')}`;
const selected = [];
for (const raw of defaultAst.body) {
  const node = declaration(raw);
  if (node?.type === 'FunctionDeclaration' && neededFunctions.has(node.id?.name)) selected.push(textOf(defaults,node));
  if (node?.type === 'FunctionDeclaration' && node.id?.name === 'initDefaultSlashCommands') {
    for (const statement of node.body.body) {
      const content = textOf(defaults,statement);
      const call = statement.expression, props = call?.arguments?.[0]?.arguments?.[0]?.properties;
      const name = props?.find(property => property.key?.name === 'name')?.value?.value;
      if (call?.callee?.object?.name === 'SlashCommandParser' && call.callee.property?.name === 'addCommandObject' && selectedCommands.has(name)) {
        selected.push(`function ${registrationName(name)}() { ${content} }`);
      }
    }
  }
}
if (selected.length !== neededFunctions.size + selectedCommands.size) throw new Error('Unexpected default command selection');
const defaultImports = `import { DOMPurify,toastr } from '/lib.js';
import { t } from '/scripts/i18n.js';
import { delay,isFalseBoolean,isTrueBoolean,regexFromString,stringToRange,trimToStartSentence,trimToEndSentence } from '/plugin-runtime/slash-utils.js';
import { chat,system_message_types,stopGeneration,reloadCurrentChat,saveSettings,saveChatConditional } from '/script.js';
import { getTokenCountAsync } from '/scripts/tokenizers.js';
import { abortableSlashDelay } from '/plugin-runtime/slash-adapter.js';
import { runSlashPopupCommand } from '/plugin-runtime/slash-popup.js';
import { runScriptInjectCommand,restoreScriptInjects } from '/plugin-runtime/slash-inject.js';
import { slashCommandReturnHelper } from './SlashCommandReturnHelper.js';
import { POPUP_TYPE,POPUP_RESULT } from '/scripts/popup.js';
import { resolveVariable } from '/plugin-runtime/variables.js';
import { SlashCommand } from './SlashCommand.js';
import { ARGUMENT_TYPE,SlashCommandArgument,SlashCommandNamedArgument } from './SlashCommandArgument.js';
import { SlashCommandClosure } from './SlashCommandClosure.js';
import { SlashCommandBreakController } from './SlashCommandBreakController.js';
import { SlashCommandNamedArgumentAssignment } from './SlashCommandNamedArgumentAssignment.js';
import { SlashCommandParser } from './SlashCommandParser.js';
import { SlashCommandExecutionError } from './SlashCommandExecutionError.js';
import { SlashCommandEnumValue,enumTypes } from './SlashCommandEnumValue.js';
import { commonEnumProviders,enumIcons } from './SlashCommandCommonEnumsProvider.js';
`;
const popupBody = 'function createPopupCommandCallbacks({Popup,callGenericPopup,delay}) {\n' + popupCallbacks.join('\n\n')
  + '\nreturn {' + popupFunctionNames.join(',') + '};\n}\n'
  + popupFunctionNames.map(name => `const ${name} = (args,value) => runSlashPopupCommand('${name}',args,value,createPopupCommandCallbacks);`).join('\n');
const injectBody = textOf(defaults,injectKey) + '\n' + textOf(defaults,filterCallback) + '\n'
  + 'function createScriptInjectCallbacks({chat_metadata,setExtensionPrompt,saveMetadataDebounced,eventSource,event_types,extension_prompt_types,extension_prompt_roles,getContext,closureToFilter,slashCommandReturnHelper}) {\n'
  + injectCallbacks.join('\n\n') + '\nreturn {' + injectFunctionNames.join(',') + '};\n}\n'
  + injectFunctionNames.filter(name=>name!=='processChatSlashCommands').map(name=>`const ${name} = (args,value) => runScriptInjectCommand('${name}',args,value,createScriptInjectCallbacks,closureToFilter);`).join('\n')
  + '\nexport const processChatSlashCommands = () => restoreScriptInjects(createScriptInjectCallbacks,closureToFilter);\n';
const defaultBody = popupBody + '\n' + injectBody + '\n' + selected.join('\n\n').replace('async function delayCallback(_, amount)', 'async function delayCallback({ _abortController }, amount)').replace('await delay(amount);', 'await abortableSlashDelay(amount, _abortController);');
store('DefaultCommands.js', defaultPath, defaultImports + defaultBody
  + '\nexport function registerDefaultCommands(){' + [...selectedCommands].map(name => `${registrationName(name)}();`).join('') + '}\n',
  'Extract 27 original complete default command descriptors including inject/listinjects/flushinject. Keep popup/injection/filter/rehydration callback text unchanged within dependency factories; scoped native dependencies own cancellation, paired ephemeral listeners and canonical metadata/prompt restoration. Filter closures receive per-evaluation controllers and correct awaited boolean evaluation at all positions (upstream IN_CHAT async Array.filter bug intentionally not copied). Live native adapters provide composer, message queries, generation stop, reload, saving and tokenization. Only delay waits add abort-listener/timer cleanup without changing successful output. Remaining native/UI registrations are outside this tranche.');

const utilsPath = 'public/scripts/utils.js', utils = readFileSync(join(root, utilsPath), 'utf8');
store('SlashUtils.js', utilsPath, "import { SlashCommandClosure } from './SlashCommandClosure.js';\n" + functionText(utils, ['convertValueType','isTrueBoolean','isFalseBoolean','escapeRegex','uuidv4','delay','regexFromString','stringToRange','trimToStartSentence','trimToEndSentence']),
  'Extract unmodified conversion, boolean, regex, UUID and delay utility implementations used by the execution core.');

const enumsPath = 'public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', enums = readFileSync(join(root, enumsPath), 'utf8');
const declarations = parse(enums).body.map(declaration);
const icons = declarations.find(node => node?.type === 'VariableDeclaration' && node.declarations[0]?.id?.name === 'enumIcons');
const providers = declarations.find(node => node?.type === 'VariableDeclaration' && node.declarations[0]?.id?.name === 'commonEnumProviders');
const enumNames = ['boolean','variables','numbersAndVariables','types','messages','injects'];
store('SlashCommandCommonEnumsProvider.js', enumsPath, `import { chat_metadata,chat,extension_prompt_roles,extension_prompt_types } from '/script.js';\nimport { extension_settings } from '/scripts/extensions.js';\nimport { SlashCommandEnumValue,enumTypes } from './SlashCommandEnumValue.js';\nexport ${textOf(enums, icons)}\nexport const commonEnumProviders = {\n`
  + providers.declarations[0].init.properties.filter(property => enumNames.includes(property.key.name)).map(property => textOf(enums, property)).join(',\n') + '\n};\n',
  'Extract unmodified icons and boolean/variable/number/type/message/injection enum providers needed by selected command families; UI/entity providers remain outside this tranche.');

const executeFunctions = functionText(defaults, ['executeSlashCommandsWithOptions','executeSlashCommands']);
store('SlashExecution.js', defaultPath, `import { toastr } from '/lib.js';\nimport { t } from '/scripts/i18n.js';\nimport { callGenericPopup,POPUP_TYPE } from '/scripts/popup.js';\nimport { SlashCommandParser } from './SlashCommandParser.js';\nimport { SlashCommandAbortController } from './SlashCommandAbortController.js';\nimport { SlashCommandParserError } from './SlashCommandParserError.js';\nimport { SlashCommandExecutionError } from './SlashCommandExecutionError.js';\nimport { SlashCommandClosureResult } from './SlashCommandClosureResult.js';\nconst parser = new SlashCommandParser();\n` + executeFunctions,
  'Extract unmodified public execution wrappers and their error/toast behavior; desktop composer uses handleParserErrors=false and converts errors to explicit failed results.');

const returnPath = 'public/scripts/slash-commands/SlashCommandReturnHelper.js';
const returnSource = readFileSync(join(root, returnPath), 'utf8').replace("import { DOMPurify, showdown } from '../../lib.js';", "import { DOMPurify,toastr } from '/lib.js';\nimport { slashMarkdown,sendSystemMessage as defaultSendSystemMessage } from '/plugin-runtime/slash-adapter.js';")
  .replace("import { sendSystemMessage, system_message_types } from '../../script.js';", "import { system_message_types } from '/script.js';")
  .replace("import { callGenericPopup, POPUP_TYPE } from '../popup.js';", "import { callGenericPopup as defaultCallGenericPopup, POPUP_TYPE } from '../popup.js';")
  .replace('(new showdown.Converter()).makeHtml(stringValue)', 'slashMarkdown(stringValue)');
const returnAst = parse(returnSource), returnStatement = returnAst.body.find(node=>node.type==='ExportNamedDeclaration' && node.declaration?.declarations?.[0]?.id?.name==='slashCommandReturnHelper');
if(!returnStatement)throw new Error('Unexpected return helper selection');
const returnFactory = 'export function createSlashCommandReturnHelper({callGenericPopup=defaultCallGenericPopup,sendSystemMessage=defaultSendSystemMessage}={}) {\n'
  + textOf(returnSource,returnStatement).replace(/^export /,'') + '\nreturn slashCommandReturnHelper;\n}\nexport const slashCommandReturnHelper=createSlashCommandReturnHelper();';
store('SlashCommandReturnHelper.js', returnPath, returnSource.slice(0,returnStatement.start)+returnFactory+returnSource.slice(returnStatement.end),
  'Keep return dispatch/converters/options in a dependency factory so listinjects popup/system-message consumers retain invocation-local lifecycle bindings. Explicitly import toastr previously provided by upstream globals. Route Markdown to the existing renderer and system-message output to native chat/persistence; do not add a parallel renderer.');

writeFileSync(resolve('apps/local-service/slash-upstream.json'), JSON.stringify({ repository:'https://github.com/SillyTavern/SillyTavern',commit,
  license:'AGPL-3.0-only',files:entries },null,2)+'\n');
writeFileSync(resolve('apps/local-service/src/plugin-runtime-slash-upstream-assets.ts'), '// Generated by scripts/import-slash-upstream.mjs. Readable corresponding source is in ../upstream-slash/.\nexport const slashUpstreamAssets: Record<string,string> = '+JSON.stringify(assets,null,2)+';\n');
console.log(JSON.stringify({files:entries.length,bytes:Object.values(assets).reduce((n,value)=>n+Buffer.byteLength(value),0)}));

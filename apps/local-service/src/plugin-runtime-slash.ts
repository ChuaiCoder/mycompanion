// Public Tavern execution entry point. The parser/closure implementation is
// reused from the fixed AGPL upstream; storage and lifecycle use native hosts.
export const slashRuntimeSource = String.raw`
import { bindSlashCommands } from '/plugin-runtime/compat-runtime.js';
import { ensureSlashDefaults,trackSlashExecution,bindSlashGenerationStop } from '/plugin-runtime/slash-adapter.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandAbortController } from './slash-commands/SlashCommandAbortController.js';
import { registerDefaultCommands,processChatSlashCommands } from './slash-commands/DefaultCommands.js';
import { initializeScriptInjects } from '/plugin-runtime/slash-inject.js';
import { registerVariableCommands } from './slash-commands/VariableCommands.js';
import { executeSlashCommandsWithOptions as executeUpstream } from './slash-commands/SlashExecution.js';
ensureSlashDefaults();
bindSlashCommands(command => SlashCommandParser.addCommandObject(command instanceof SlashCommand ? command
  : Object.assign(SlashCommand.fromProps(command), {owner:command.owner,description:command.description,prompt:command.prompt})), executeSlashCommandsWithOptions);
let initialized = false;
export function initDefaultSlashCommands() {
  if (initialized) return;
  initialized = true; registerDefaultCommands(); registerVariableCommands();
  bindSlashGenerationStop(SlashCommandParser.commands.stop);
  initializeScriptInjects(processChatSlashCommands);
}
initDefaultSlashCommands();
export const registerSlashCommand = SlashCommandParser.addCommand.bind(SlashCommandParser);
export const getSlashCommandsHelp = (...args) => new SlashCommandParser().getHelpString(...args);
export function executeSlashCommands(text,handleParserErrors=true,scope=null,handleExecutionErrors=false,parserFlags=null,abortController=null,onProgress=null) {
  return executeSlashCommandsWithOptions(text,{handleParserErrors,scope,handleExecutionErrors,parserFlags,abortController,onProgress});
}
export async function executeSlashCommandsOnChatInput(text,options={}) {
  const textarea=document.querySelector('#send_textarea');
  if(options.clearChatInput&&textarea){textarea.value='';textarea.dispatchEvent(new Event('input',{bubbles:true}));}
  return executeSlashCommandsWithOptions(text,{...options,handleExecutionErrors:true});
}
export async function executeSlashCommandsWithOptions(text, options = {}) {
  ensureSlashDefaults();
  const controller = options.abortController ?? new SlashCommandAbortController();
  const release = trackSlashExecution(controller);
  try { return await executeUpstream(text, {...options,abortController:controller}); }
  finally { release(); }
}
`;

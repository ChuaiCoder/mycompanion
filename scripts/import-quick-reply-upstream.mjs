// Reuse execution/automation without bringing the upstream QR editor UI.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
const commit='7e8663cd9c184a550b37238218bdd32c6efc68e9',root=resolve(process.argv[2]??`.cache/research/SillyTavern-${commit}`);
const base='public/scripts/extensions/quick-reply/',paths=['src/AutoExecuteHandler.js','src/QuickReply.js','src/QuickReplySet.js','index.js'];
const sources=Object.fromEntries(paths.map(path=>[path,readFileSync(join(root,base,path),'utf8')]));
const declarations=source=>parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.map(node=>node.type==='ExportNamedDeclaration'?node.declaration:node);
const klass=(path,name)=>declarations(sources[path]).find(node=>node?.type==='ClassDeclaration'&&node.id.name===name);
const select=(path,name,methods)=>klass(path,name).body.body.filter(node=>node.type==='PropertyDefinition'&&node.value||node.type==='MethodDefinition'&&methods.includes(node.key.name))
  .map(node=>sources[path].slice(node.start,node.end)).join('\n');
const declaration=(path,name)=>{const node=declarations(sources[path]).find(node=>node?.id?.name===name||node?.declarations?.some(item=>item.id.name===name));
  if(!node)throw new Error('Missing QR declaration '+name);return sources[path].slice(node.start,node.end);};
const index=declarations(sources['index.js']).find(node=>node?.id?.name==='init');
const assignment=index.body.body.find(node=>node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'&&node.expression.left.object?.name==='globalThis'&&node.expression.left.property?.name==='executeQuickReplyByName').expression.right;
const source=`/*! Reused SillyTavern 1.19.0, ${commit}, AGPL-3.0-only. See quick-reply-upstream.json and THIRD_PARTY_NOTICES.md. */
import {getRequestHeaders} from '/plugin-runtime/compat-runtime.js';
import {substituteParams} from '/plugin-runtime/macros.js';
import {executeSlashCommandsWithOptions,executeSlashCommandsOnChatInput} from '/scripts/slash-commands.js';
import {SlashCommandScope} from '/scripts/slash-commands/SlashCommandScope.js';
import {SlashCommandAbortController} from '/scripts/slash-commands/SlashCommandAbortController.js';
import {quickReplyDocument as document} from '/plugin-runtime/quick-reply-document.js';
const warn=(...args)=>console.warn('[Quick Reply]',...args),log=()=>{};
export class QuickReply {
${select('src/QuickReply.js','QuickReply',['execute'])}
static from(props){return Object.assign(new this(),props);}
}
export class QuickReplySet {
${select('src/QuickReplySet.js','QuickReplySet',['from','get','executeWithOptions','execute'])}
init(){this.qrList.forEach(qr=>{qr.onExecute=(_,options)=>this.executeWithOptions(qr,options);});}
}
export ${declaration('src/AutoExecuteHandler.js','AutoExecuteHandler')}
export ${declaration('index.js','loadSets')}
export function createQuickReplyNamedExecutor(settings){return ${sources['index.js'].slice(assignment.start,assignment.end)};}
`;
const sha=value=>createHash('sha256').update(value).digest('hex');
writeFileSync(resolve('apps/local-service/src/quick-reply-upstream.ts'),`// Browser ESM, generated from fixed reviewed AGPL source.\nexport const quickReplyUpstreamSource=${JSON.stringify(source)};\n`);
writeFileSync(resolve('apps/local-service/quick-reply-upstream.json'),JSON.stringify({repository:'https://github.com/SillyTavern/SillyTavern',commit,license:'AGPL-3.0-only',
  path:'src/quick-reply-upstream.ts',adaptedSha256:sha(`// Browser ESM, generated from fixed reviewed AGPL source.\nexport const quickReplyUpstreamSource=${JSON.stringify(source)};\n`),
  files:paths.map(path=>({upstreamPath:base+path,upstreamSha256:sha(sources[path])})),components:['AutoExecuteHandler','QuickReply.execute','QuickReplySet.executeWithOptions/execute/from/get','loadSets (including legacy migration)','executeQuickReplyByName'],
  adaptation:'Retain initialized model defaults and execution methods unmodified. Native fact storage supplies settings/get quickReplyPresets. Model construction hooks only execution; the upstream editor, buttons, context menus and DOM lifecycle are omitted. A host wrapper supplies invocation cancellation; a document adapter maps the original textarea assignment/button click to actual native React composer callbacks and honors the real disabled button. Neither changes the original execution bodies.'},null,2)+'\n');
console.log(JSON.stringify({bytes:Buffer.byteLength(source),sha256:sha(source)}));

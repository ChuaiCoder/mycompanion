/*! Adapted from SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9. AGPL-3.0-only. See slash-upstream.json and THIRD_PARTY_NOTICES.md. */
import { DOMPurify,toastr } from '/lib.js';
import { t } from '/scripts/i18n.js';
import { delay,isFalseBoolean,isTrueBoolean } from '/plugin-runtime/slash-utils.js';
import { abortableSlashDelay } from '/plugin-runtime/slash-adapter.js';
import { resolveVariable } from '/plugin-runtime/variables.js';
import { SlashCommand } from './SlashCommand.js';
import { ARGUMENT_TYPE,SlashCommandArgument,SlashCommandNamedArgument } from './SlashCommandArgument.js';
import { SlashCommandClosure } from './SlashCommandClosure.js';
import { SlashCommandBreakController } from './SlashCommandBreakController.js';
import { SlashCommandNamedArgumentAssignment } from './SlashCommandNamedArgumentAssignment.js';
import { SlashCommandParser } from './SlashCommandParser.js';
import { SlashCommandEnumValue,enumTypes } from './SlashCommandEnumValue.js';
import { commonEnumProviders,enumIcons } from './SlashCommandCommonEnumsProvider.js';
function register_echo() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'echo',
        rawQuotes: true,
        callback: echoCallback,
        returns: t`the text`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'title', t`title of the toast message`, [ARGUMENT_TYPE.STRING], false,
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'severity',
                description: t`severity level of the toast message`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'info',
                enumProvider: () => [
                    new SlashCommandEnumValue('info', 'info', enumTypes.macro, 'ℹ️'),
                    new SlashCommandEnumValue('warning', 'warning', enumTypes.enum, '⚠️'),
                    new SlashCommandEnumValue('error', 'error', enumTypes.enum, '❗'),
                    new SlashCommandEnumValue('success', 'success', enumTypes.enum, '✅'),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'timeout',
                description: t`time in milliseconds to display the toast message. Set this and 'extendedTimeout' to 0 to show indefinitely until dismissed.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: `${toastr.options.timeOut}`,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'extendedTimeout',
                description: t`time in milliseconds to display the toast message. Set this and 'timeout' to 0 to show indefinitely until dismissed.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: `${toastr.options.extendedTimeOut}`,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'preventDuplicates',
                description: t`prevent duplicate toasts with the same message from being displayed.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'awaitDismissal',
                description: t`wait for the toast to be dismissed before continuing.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cssClass',
                description: t`additional CSS class to add to the toast message (e.g. for custom styling)`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'color',
                description: t`custom CSS color of the toast message. Accepts all valid CSS color values (e.g. 'red', '#FF0000', 'rgb(255, 0, 0)').<br />>Can be more customizable with the 'cssClass' argument and custom classes.`,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'escapeHtml',
                description: t`whether to escape HTML in the toast message.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onClick',
                description: t`a closure to call when the toast is clicked. This executed closure receives scope as provided in the script. Careful about possible side effects when manipulating variables and more.`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: t`If true, does not alter quoted literal unnamed arguments`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            Echoes the provided text to a toast message. Can be used to display informational messages or for pipes debugging.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/echo title="My Message" severity=warning This is a warning message</code></pre>
                </li>
                <li>
                    <pre><code>/echo color=purple This message is purple</code></pre>
                </li>
                <li>
                    <pre><code>/echo onClick={: /echo escapeHtml=false color=transparent cssClass=wider_dialogue_popup &lt;img src="/img/five.png" /&gt; :} timeout=5000 Clicking on this message within 5 seconds will open the image.</code></pre>
                </li>
            </ul>
        </div>
    `,
    })); }

function register_abort() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'abort',
        callback: abortCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: t`Whether to suppress the toast message notifying about the /abort call.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`The reason for aborting command execution. Shown when quiet=false`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: t`Aborts the slash command batch execution.`,
    })); }

function register_pass() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pass',
        callback: (_, arg) => {
            // We do not support arrays of closures. Arrays of strings will be send as JSON
            if (Array.isArray(arg) && arg.some(x => x instanceof SlashCommandClosure)) throw new Error(t`Command /pass does not support multiple closures`);
            if (Array.isArray(arg)) return JSON.stringify(arg);
            return arg;
        },
        returns: t`the provided value`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY, ARGUMENT_TYPE.CLOSURE], true,
            ),
        ],
        aliases: ['return'],
        helpString: `
        <div>
            <pre><span class="monospace">/pass (text)</span> – ${t`passes the text to the next command through the pipe.`}</pre>
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code>/pass Hello world</code></pre></li>
            </ul>
        </div>
    `,
    })); }

function register_delay() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'delay',
        callback: delayCallback,
        aliases: ['wait', 'sleep'],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`milliseconds`, [ARGUMENT_TYPE.NUMBER], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Delays the next command in the pipe by the specified number of milliseconds.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/delay 1000</code></pre>
                </li>
            </ul>
        </div>
    `,
    })); }

function register_run() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'run',
        aliases: ['call', 'exec'],
        callback: runCallback,
        returns: t`result of the executed closure of QR`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'args', t`named arguments`, [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY], false, true,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`scoped variable or qr label`,
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.CLOSURE],
                isRequired: true,
                enumProvider: (executor, scope) => [
                    ...commonEnumProviders.variables('scope')(executor, scope),
                    ...(typeof globalThis.qrEnumProviderExecutables === 'function') ? globalThis.qrEnumProviderExecutables() : [],
                ],
            }),
        ],
        helpString: `
        <div>
            ${t`Runs a closure from a scoped variable, or a Quick Reply with the specified name from a currently active preset or from another preset.`}
            ${t`Named arguments can be referenced in a QR with <code>{{arg::key}}</code>.`}
        </div>
    `,
    })); }

async function runCallback(args, name) {
    if (!name) {
        throw new Error(t`No name provided for /run command`);
    }

    if (name instanceof SlashCommandClosure) {
        name.breakController = new SlashCommandBreakController();
        return (await name.execute())?.pipe;
    }

    /**@type {SlashCommandScope} */
    const scope = args._scope;
    if (scope.existsVariable(name)) {
        const closure = scope.getVariable(name);
        if (!(closure instanceof SlashCommandClosure)) {
            throw new Error(t`"${name}" is not callable.`);
        }
        closure.scope.parent = scope;
        closure.breakController = new SlashCommandBreakController();
        if (args._debugController && !closure.debugController) {
            closure.debugController = args._debugController;
        }
        while (closure.providedArgumentList.pop());
        closure.argumentList.forEach(arg => {
            if (Object.keys(args).includes(arg.name)) {
                const providedArg = new SlashCommandNamedArgumentAssignment();
                providedArg.name = arg.name;
                providedArg.value = args[arg.name];
                closure.providedArgumentList.push(providedArg);
            }
        });
        const result = await closure.execute();
        return result.pipe;
    }

    if (typeof globalThis.executeQuickReplyByName !== 'function') {
        throw new Error(t`Quick Reply extension is not loaded`);
    }

    try {
        name = name.trim();
        /**@type {ExecuteSlashCommandsOptions} */
        const options = {
            abortController: args._abortController,
            debugController: args._debugController,
        };
        return await globalThis.executeQuickReplyByName(name, args, options);
    } catch (error) {
        throw new Error(t`Error running Quick Reply "${name}": ${error.message}`);
    }
}

function abortCallback({ _abortController, quiet }, reason) {
    if (quiet instanceof SlashCommandClosure) throw new Error(t`argument 'quiet' cannot be a closure for command /abort`);
    _abortController.abort((reason ?? '').toString().length == 0 ? t`/abort command executed` : reason, !isFalseBoolean(quiet?.toString() ?? 'true'));
    return '';
}

async function delayCallback({ _abortController }, amount) {
    if (!amount) {
        console.warn('WARN: No amount provided for /delay command');
        return '';
    }

    amount = Number(amount);
    if (isNaN(amount)) {
        amount = 0;
    }

    await abortableSlashDelay(amount, _abortController);
    return '';
}

async function echoCallback(args, value) {
    // Note: We don't need to sanitize input, as toastr is set up by default to escape HTML via toastr options
    if (value === '') {
        console.warn('WARN: No argument provided for /echo command');
        return '';
    }

    if (args.severity && !['error', 'warning', 'success', 'info'].includes(args.severity)) {
        toastr.warning(t`Invalid severity provided for /echo command: ${args.severity}`);
        args.severity = null;
    }

    // Make sure that the value is a string
    value = String(value);

    let title = args.title ? args.title : undefined;
    const severity = args.severity ? args.severity : 'info';

    /** @type {ToastrOptions} */
    const options = {};
    if (args.timeout && !isNaN(parseInt(args.timeout))) options.timeOut = parseInt(args.timeout);
    if (args.extendedTimeout && !isNaN(parseInt(args.extendedTimeout))) options.extendedTimeOut = parseInt(args.extendedTimeout);
    if (isTrueBoolean(args.preventDuplicates)) options.preventDuplicates = true;
    if (args.cssClass) options.toastClass = [options.toastClass, args.cssClass].filter(Boolean).join(' ');
    options.escapeHtml = args.escapeHtml !== undefined ? isTrueBoolean(args.escapeHtml) : true;

    // Prepare possible await handling
    let awaitDismissal = isTrueBoolean(args.awaitDismissal);
    let resolveToastDismissal;

    if (awaitDismissal) {
        options.onHidden = () => resolveToastDismissal(value);
    }
    if (args.onClick) {
        if (args.onClick instanceof SlashCommandClosure) {
            options.onclick = async () => {
                // Execute the slash command directly, with its internal scope and everything. Clear progress handler so it doesn't interfere with command execution progress.
                args.onClick.onProgress = null;
                await args.onClick.execute();
            };
        } else {
            toastr.warning(t`Invalid onClick provided for /echo command. This is not a closure`);
        }
    }

    // If we allow HTML, we need to sanitize it to prevent security risks
    if (!options.escapeHtml) {
        if (title) title = DOMPurify.sanitize(title, { FORBID_TAGS: ['style'] });
        value = DOMPurify.sanitize(value, { FORBID_TAGS: ['style'] });
    }

    let toast;
    switch (severity) {
        case 'error':
            toast = toastr.error(value, title, options);
            break;
        case 'warning':
            toast = toastr.warning(value, title, options);
            break;
        case 'success':
            toast = toastr.success(value, title, options);
            break;
        case 'info':
        default:
            toast = toastr.info(value, title, options);
            break;
    }

    if (args.color) {
        toast.css('background-color', args.color);
    }

    if (awaitDismissal) {
        return new Promise((resolve) => {
            resolveToastDismissal = resolve;
        });
    } else {
        return value;
    }
}
export function registerDefaultCommands(){register_run();register_abort();register_delay();register_pass();register_echo();}

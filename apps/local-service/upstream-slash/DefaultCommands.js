/*! Adapted from SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9. AGPL-3.0-only. See slash-upstream.json and THIRD_PARTY_NOTICES.md. */
import { DOMPurify,toastr } from '/lib.js';
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
function createPopupCommandCallbacks({Popup,callGenericPopup,delay}) {
async function buttonsCallback(args, text) {
    try {
        /** @type {(string|ButtonLabel)[]} */
        const rawButtons = JSON.parse(resolveVariable(args?.labels));

        if (!Array.isArray(rawButtons) || !rawButtons.length) {
            console.warn('WARN: Invalid labels provided for /buttons command');
            return '';
        }

        // Normalize buttons to ButtonLabel format for consistent handling
        /** @type {ButtonLabel[]} */
        const buttons = rawButtons.map(btn => typeof btn === 'string' ? { text: btn } : btn);

        // Validate raw buttons: each entry must be a string or a non-null object with a string `text` field that has content
        if (!buttons.every(btn => typeof btn === 'object' && btn !== null && typeof btn.text === 'string' && btn.text)) {
            console.warn('WARN: Invalid button label entry provided for /buttons command: each entry must be a string or an object with a "text" property');
            return '';
        }

        /** @type {Set<number>} */
        const multipleToggledState = new Set();
        const multiple = isTrueBoolean(args?.multiple);

        // Map custom buttons to results. Start at 2 because 1 and 0 are reserved for ok and cancel
        /** @type {Map<number, ButtonLabel>} */
        const resultToButtonMap = new Map(buttons.map((button, index) => [index + 2, button]));

        return new Promise(async (resolve) => {
            const safeValue = DOMPurify.sanitize(text || '');

            /** @type {Popup} */
            let popup;

            const buttonContainer = document.createElement('div');
            buttonContainer.classList.add('flex-container', 'flexFlowColumn', 'wide100p');

            const scrollableContainer = document.createElement('div');
            scrollableContainer.classList.add('scrollable-buttons-container');

            for (const [result, button] of resultToButtonMap) {
                const buttonElement = document.createElement('div');
                buttonElement.classList.add('menu_button', 'wide100p');

                if (multiple) {
                    buttonElement.classList.add('toggleable');
                    buttonElement.dataset.toggleValue = String(result);
                    buttonElement.addEventListener('click', async () => {
                        buttonElement.classList.toggle('toggled');
                        if (buttonElement.classList.contains('toggled')) {
                            multipleToggledState.add(result);
                        } else {
                            multipleToggledState.delete(result);
                        }
                    });
                } else {
                    buttonElement.classList.add('result-control');
                    buttonElement.dataset.result = String(result);
                }

                // Add icon if provided
                if (button.icon) {
                    const icon = document.createElement('i');
                    icon.className = `fa-solid ${button.icon}`;
                    icon.style.marginRight = '0.5em';
                    buttonElement.appendChild(icon);
                    const textSpan = document.createElement('span');
                    textSpan.textContent = button.text;
                    buttonElement.appendChild(textSpan);
                } else {
                    buttonElement.innerText = button.text;
                }

                // Add tooltip if provided
                if (button.tooltip) {
                    buttonElement.title = button.tooltip;
                    buttonElement.dataset.i18n = '[title]' + button.tooltip;
                }

                buttonContainer.appendChild(buttonElement);
            }

            scrollableContainer.appendChild(buttonContainer);

            const popupContainer = document.createElement('div');
            popupContainer.innerHTML = safeValue;
            popupContainer.appendChild(scrollableContainer);

            // Ensure the popup uses flex layout
            popupContainer.style.display = 'flex';
            popupContainer.style.flexDirection = 'column';
            popupContainer.style.maxHeight = '80vh'; // Limit the overall height of the popup

            popup = new Popup(popupContainer, POPUP_TYPE.TEXT, '', { okButton: multiple ? t`Ok` : t`Cancel`, allowVerticalScrolling: true });
            popup.show()
                .then((result => resolve(getResult(result))))
                .catch(() => resolve(''));

            /** @returns {string} @param {string|number|boolean} result */
            function getResult(result) {
                if (multiple) {
                    const array = result === POPUP_RESULT.AFFIRMATIVE ? Array.from(multipleToggledState).map(r => resultToButtonMap.get(r)?.text ?? '') : [];
                    return JSON.stringify(array);
                }
                return typeof result === 'number' ? resultToButtonMap.get(result)?.text ?? '' : '';
            }
        });
    } catch {
        return '';
    }
}

async function popupCallback(args, value) {
    const safeBody = DOMPurify.sanitize(value || '');
    const safeHeader = args?.header && typeof args?.header === 'string' ? DOMPurify.sanitize(args.header) : null;
    const requestedResult = isTrueBoolean(args?.result);

    /** @type {import('./popup.js').PopupOptions} */
    const popupOptions = {
        allowVerticalScrolling: !isFalseBoolean(args?.scroll),
        large: isTrueBoolean(args?.large),
        wide: isTrueBoolean(args?.wide),
        wider: isTrueBoolean(args?.wider),
        transparent: isTrueBoolean(args?.transparent),
        okButton: args?.okButton !== undefined && typeof args?.okButton === 'string' ? args.okButton : t`OK`,
        cancelButton: args?.cancelButton !== undefined && typeof args?.cancelButton === 'string' ? args.cancelButton : null,
        tooltip: args?.tooltip !== undefined && typeof args?.tooltip === 'string' ? args.tooltip : null,
    };
    const result = await Popup.show.text(safeHeader, safeBody, popupOptions);
    return String(requestedResult ? result ?? '' : value);
}

async function inputCallback(args, prompt) {
    const safeValue = DOMPurify.sanitize(prompt || '');
    const defaultInput = args?.default !== undefined && typeof args?.default === 'string' ? args.default : '';
    const popupOptions = {
        large: isTrueBoolean(args?.large),
        wide: isTrueBoolean(args?.wide),
        okButton: args?.okButton !== undefined && typeof args?.okButton === 'string' ? args.okButton : t`Ok`,
        rows: args?.rows !== undefined && typeof args?.rows === 'string' ? isNaN(Number(args.rows)) ? 4 : Number(args.rows) : 4,
        placeholder: args?.placeholder !== undefined && typeof args?.placeholder === 'string' ? args.placeholder : null,
        tooltip: args?.tooltip !== undefined && typeof args?.tooltip === 'string' ? args.tooltip : null,
    };
    // Do not remove this delay, otherwise the prompt will not show up
    await delay(1);
    const result = await callGenericPopup(safeValue, POPUP_TYPE.INPUT, defaultInput, popupOptions);
    await delay(1);

    // Input will return null on nothing entered, and false on cancel clicked
    if (result === null || result === false) {
        // Veryify if a cancel handler exists and it is valid
        if (args?.onCancel) {
            if (!(args.onCancel instanceof SlashCommandClosure)) {
                throw new Error(t`argument 'onCancel' must be a closure for command /input`);
            }
            await args.onCancel.execute();
        }
    } else {
        // Verify if an ok handler exists and it is valid
        if (args?.onSuccess) {
            if (!(args.onSuccess instanceof SlashCommandClosure)) {
                throw new Error(t`argument 'onSuccess' must be a closure for command /input`);
            }
            await args.onSuccess.execute();
        }
    }

    return String(result || '');
}
return {inputCallback,popupCallback,buttonsCallback};
}
const inputCallback = (args,value) => runSlashPopupCommand('inputCallback',args,value,createPopupCommandCallbacks);
const popupCallback = (args,value) => runSlashPopupCommand('popupCallback',args,value,createPopupCommandCallbacks);
const buttonsCallback = (args,value) => runSlashPopupCommand('buttonsCallback',args,value,createPopupCommandCallbacks);
const SCRIPT_PROMPT_KEY = 'script_inject_';
function closureToFilter(closure) {
    return async () => {
        try {
            const localClosure = closure.getCopy();
            localClosure.onProgress = () => { };
            const result = await localClosure.execute();
            return isTrueBoolean(result.pipe);
        } catch (e) {
            console.error('Error executing filter closure', e);
            return false;
        }
    };
}
function createScriptInjectCallbacks({chat_metadata,setExtensionPrompt,saveMetadataDebounced,eventSource,event_types,extension_prompt_types,extension_prompt_roles,getContext,closureToFilter,slashCommandReturnHelper}) {
function injectCallback(args, value) {
    const positions = {
        'before': extension_prompt_types.BEFORE_PROMPT,
        'after': extension_prompt_types.IN_PROMPT,
        'chat': extension_prompt_types.IN_CHAT,
        'none': extension_prompt_types.NONE,
    };
    const roles = {
        'system': extension_prompt_roles.SYSTEM,
        'user': extension_prompt_roles.USER,
        'assistant': extension_prompt_roles.ASSISTANT,
    };

    const id = String(args?.id ?? '') || Math.random().toString(36).substring(2);
    const ephemeral = isTrueBoolean(String(args?.ephemeral ?? ''));

    const defaultPosition = 'after';
    const defaultDepth = 4;
    const positionValue = args?.position ?? defaultPosition;
    const position = positions[positionValue] ?? positions[defaultPosition];
    const depthValue = Number(args?.depth ?? defaultDepth);
    const depth = isNaN(depthValue) ? defaultDepth : depthValue;
    const roleValue = typeof args?.role === 'string' ? args.role.toLowerCase().trim() : Number(args?.role ?? extension_prompt_roles.SYSTEM);
    const role = roles[roleValue] ?? extension_prompt_roles.SYSTEM;
    const scan = isTrueBoolean(String(args?.scan));
    const filter = args?.filter instanceof SlashCommandClosure ? args.filter.rawText : null;
    const filterFunction = args?.filter instanceof SlashCommandClosure ? closureToFilter(args.filter) : null;
    value = value || '';
    if (args?.filter && !String(filter ?? '').trim()) {
        throw new Error(t`Failed to parse the filter argument. Make sure it is a valid non-empty closure.`);
    }

    const prefixedId = `${SCRIPT_PROMPT_KEY}${id}`;

    if (!chat_metadata.script_injects) {
        chat_metadata.script_injects = {};
    }

    if (value) {
        const inject = { value, position, depth, scan, role, filter };
        chat_metadata.script_injects[id] = inject;
    } else {
        delete chat_metadata.script_injects[id];
    }

    setExtensionPrompt(prefixedId, String(value), position, depth, scan, role, filterFunction);
    saveMetadataDebounced();

    if (ephemeral) {
        let deleted = false;
        const unsetInject = () => {
            if (deleted) {
                return;
            }
            console.log('Removing ephemeral script injection', id);
            delete chat_metadata.script_injects[id];
            setExtensionPrompt(prefixedId, '', position, depth, scan, role, filterFunction);
            saveMetadataDebounced();
            deleted = true;
        };
        eventSource.once(event_types.GENERATION_ENDED, unsetInject);
        eventSource.once(event_types.GENERATION_STOPPED, unsetInject);
    }

    return id;
}

async function listInjectsCallback(args) {
    /** @type {import('./slash-commands/SlashCommandReturnHelper.js').SlashCommandReturnType} */
    let returnType = args.return;

    // Now the actual new return type handling
    const buildTextValue = (injects) => {
        const injectsStr = Object.entries(injects)
            .map(([id, inject]) => {
                const position = Object.entries(extension_prompt_types);
                const positionName = position.find(([_, value]) => value === inject.position)?.[0] ?? t`unknown`;
                return `* **${id}**: <code>${inject.value}</code> (${positionName}, ${t`depth`}: ${inject.depth}, ${t`scan`}: ${inject.scan ?? false}, ${t`role`}: ${inject.role ?? extension_prompt_roles.SYSTEM})`;
            })
            .join('\n');
        return `### ${t`Script injections:`}\n${injectsStr || t`No script injections for the current chat`}`;
    };

    return await slashCommandReturnHelper.doReturn(returnType ?? 'popup-html', chat_metadata.script_injects ?? {}, { objectToStringFunc: buildTextValue });
}

function flushInjectsCallback(_, value) {
    if (!chat_metadata.script_injects) {
        return '';
    }

    const idArgument = value;

    for (const [id, inject] of Object.entries(chat_metadata.script_injects)) {
        if (idArgument && id !== idArgument) {
            continue;
        }

        const prefixedId = `${SCRIPT_PROMPT_KEY}${id}`;
        setExtensionPrompt(prefixedId, '', inject.position, inject.depth, inject.scan, inject.role);
        delete chat_metadata.script_injects[id];
    }

    saveMetadataDebounced();
    return '';
}

function processChatSlashCommands() {
    const context = getContext();

    if (!(context.chatMetadata.script_injects)) {
        return;
    }

    for (const id of Object.keys(context.extensionPrompts)) {
        if (!id.startsWith(SCRIPT_PROMPT_KEY)) {
            continue;
        }

        console.log('Removing script injection', id);
        delete context.extensionPrompts[id];
    }

    for (const [id, inject] of Object.entries(context.chatMetadata.script_injects)) {
        /**
         * Rehydrates a filter closure from a string.
         * @returns {SlashCommandClosure | null}
         */
        function reviveFilterClosure() {
            if (!inject.filter) {
                return null;
            }

            try {
                return new SlashCommandParser().parse(inject.filter, true);
            } catch (error) {
                console.warn('Failed to revive filter closure for script injection', id, error);
                return null;
            }
        }

        const prefixedId = `${SCRIPT_PROMPT_KEY}${id}`;
        const filterClosure = reviveFilterClosure();
        const filter = filterClosure ? closureToFilter(filterClosure) : null;
        console.log('Adding script injection', id);
        setExtensionPrompt(prefixedId, inject.value, inject.position, inject.depth, inject.scan, inject.role, filter);
    }
}
return {injectCallback,listInjectsCallback,flushInjectsCallback,processChatSlashCommands};
}
const injectCallback = (args,value) => runScriptInjectCommand('injectCallback',args,value,createScriptInjectCallbacks,closureToFilter);
const listInjectsCallback = (args,value) => runScriptInjectCommand('listInjectsCallback',args,value,createScriptInjectCallbacks,closureToFilter);
const flushInjectsCallback = (args,value) => runScriptInjectCommand('flushInjectsCallback',args,value,createScriptInjectCallbacks,closureToFilter);
export const processChatSlashCommands = () => restoreScriptInjects(createScriptInjectCallbacks,closureToFilter);

function register_forcesave() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'forcesave',
        callback: async function () {
            await saveSettings();
            await saveChatConditional();
            toastr.success(t`Chat and settings saved.`);
            return '';
        },
        helpString: t`Forces a save of the current chat and settings`,
    })); }

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

function register_stop() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'stop',
        callback: () => {
            const stopped = stopGeneration();
            return String(stopped);
        },
        returns: t`true/false, whether the generation was running and got stopped`,
        helpString: `
            <div>
                ${t`Stops the generation and any streaming if it is currently running.`}
            </div>
            <div>
                ${t`Note: This command cannot be executed from the chat input, as sending any message or script from there is blocked during generation. But it can be executed via automations or QR scripts/buttons.`}
            </div>
        `,
        aliases: ['generate-stop'],
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

function register_input() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'input',
        aliases: ['prompt'],
        callback: inputCallback,
        returns: t`user input`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'default',
                description: t`default value of the input field`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'large',
                description: t`popup window will be shown larger in height, with more space for content (input field needs to be sized via 'rows' argument)`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'off',
                enumList: commonEnumProviders.boolean('onOff')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'wide',
                description: t`popup window will be shown wider, with a wider input field`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'off',
                enumList: commonEnumProviders.boolean('onOff')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'okButton',
                description: t`text for the ok button`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'Ok',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'rows',
                description: t`number of rows for the input field (lines being displayed)`,
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'placeholder',
                description: t`placeholder text displayed in the input field when empty`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'tooltip',
                description: t`tooltip text shown when hovering over the input field`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onSuccess',
                description: t`closure to execute when the ok button is clicked or the input is closed as successful (via Enter, etc)`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onCancel',
                description: t`closure to execute when the cancel button is clicked or the input is closed as cancelled (via Escape, etc)`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`text to display`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: `
        <div>
            ${t`Shows a popup with the provided text and an input field.`}
            ${t`The <code>default</code> argument is the default value of the input field, and the text argument is the text to display.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/input default="John" placeholder="Enter your name" tooltip="Your display name" What is your name?</code></pre>
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

function register_messages() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'messages',
        callback: getMessagesCallback,
        aliases: ['message'],
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'names', t`show message author names`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'off', commonEnumProviders.boolean('onOff')(),
            ),
            new SlashCommandNamedArgument(
                'hidden', t`include hidden messages`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'on', commonEnumProviders.boolean('onOff')(),
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'role',
                description: t`filter messages by role`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.system),
                    new SlashCommandEnumValue('assistant', null, enumTypes.enum, enumIcons.assistant),
                    new SlashCommandEnumValue('user', null, enumTypes.enum, enumIcons.user),
                ],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`message index (starts with 0) or range`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
                isRequired: true,
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        returns: t`the specified message or range of messages as a string`,
        helpString: `
        <div>
            ${t`Returns the specified message or range of messages as a string.`}
        </div>
        <div>
            ${t`Use the <code>hidden=off</code> argument to exclude hidden messages.`}
        </div>
        <div>
            ${t`Use the <code>role</code> argument to filter messages by role. Possible values are: system, assistant, user.`}
        </div>
        <div>
            <strong>${t`Examples:`}</strong>
            <ul>
                <li>
                    <pre><code>/messages 10</code></pre>
                    ${t`Returns the 10th message.`}
                </li>
                <li>
                    <pre><code>/messages names=on 5-10</code></pre>
                    ${t`Returns messages 5 through 10 with author names.`}
                </li>
            </ul>
        </div>
    `,
    })); }

function register_setinput() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'setinput',
        callback: setInputCallback,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Sets the user input to the specified text and passes it to the next command through the pipe.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/setinput Hello world</code></pre>
                </li>
            </ul>
        </div>
    `,
    })); }

function register_popup() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'popup',
        callback: popupCallback,
        returns: t`Popup text`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'scroll',
                description: t`allows vertical scrolling of the content`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'true',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'large',
                description: t`show large popup`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'wide',
                description: t`show wide popup`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'wider',
                description: t`show wider popup`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'transparent',
                description: t`show transparent popup`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'okButton',
                description: t`text for the OK button`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'OK',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cancelButton',
                description: t`text for the Cancel button`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'result',
                description: t`if enabled, returns the popup result (as an integer) instead of the popup text. Resolves to 1 for OK and 0 cancel button, empty string for exiting out.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'tooltip',
                description: t`tooltip text shown when hovering over the popup content area`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`popup text`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            ${t`Shows a blocking popup with the specified text and buttons.`}
            ${t`Returns the popup text.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/popup large=on wide=on okButton="Confirm" Please confirm this action.</code></pre>
                </li>
                <li>
                    <pre><code>/popup okButton="Left" cancelButton="Right" result=true Do you want to go left or right? | /echo 0 means right, 1 means left. Choice: {{pipe}}</code></pre>
                </li>
            </ul>
        </div>
    `,
    })); }

function register_buttons() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'buttons',
        callback: buttonsCallback,
        returns: t`clicked button label (or array of labels if multiple is enabled)`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'labels',
                description: t`button labels - can be an array of strings or objects with text, tooltip, and icon properties`,
                typeList: [ARGUMENT_TYPE.LIST],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'multiple',
                description: t`if enabled multiple buttons can be clicked/toggled, and all clicked buttons are returned as an array`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`text`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            ${t`Shows a blocking popup with the specified text and buttons.`}
            ${t`Returns the clicked button label into the pipe or empty string if canceled.`}
        </div>
        <div>
            ${t`Labels can be simple strings or objects with <code>text</code>, <code>tooltip</code>, and <code>icon</code> (Font Awesome class) properties.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/buttons labels=["Yes","No"] Do you want to continue?</code></pre>
                </li>
                <li>
                    <pre><code>/buttons labels=[{"text":"Save","icon":"fa-floppy-disk","tooltip":"Save changes"},{"text":"Cancel"}] Choose an action</code></pre>
                </li>
            </ul>
        </div>
    `,
    })); }

function register_trimstart() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'trimstart',
        callback: trimStartCallback,
        returns: t`trimmed text`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Trims the text to the start of the first full sentence.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/trimstart This is a sentence. And here is another sentence.</code></pre>
                </li>
            </ul>
        </div>
    `,
    })); }

function register_trimend() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'trimend',
        callback: trimEndCallback,
        returns: t`trimmed text`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: t`Trims the text to the end of the last full sentence.`,
    })); }

function register_inject() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'inject',
        returns: t`injection ID`,
        callback: injectCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'id',
                description: t`injection ID`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: commonEnumProviders.injects,
            }),
            new SlashCommandNamedArgument(
                'position', t`injection position`, [ARGUMENT_TYPE.STRING], false, false, 'after', ['before', 'after', 'chat', 'none'],
            ),
            new SlashCommandNamedArgument(
                'depth', t`injection depth`, [ARGUMENT_TYPE.NUMBER], false, false, '4',
            ),
            new SlashCommandNamedArgument(
                'scan', t`include injection content into World Info scans`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'role',
                description: t`role for in-chat injections`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.system),
                    new SlashCommandEnumValue('assistant', null, enumTypes.enum, enumIcons.assistant),
                    new SlashCommandEnumValue('user', null, enumTypes.enum, enumIcons.user),
                ],
            }),
            new SlashCommandNamedArgument(
                'ephemeral', t`remove injection after generation`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'filter',
                description: t`if a filter is defined, an injection will only be performed if the closure returns true`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
                isRequired: false,
                acceptsMultiple: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: t`Injects a text into the LLM prompt for the current chat. Requires a unique injection ID (will be auto-generated if not provided). Positions: "before" main prompt, "after" main prompt, in-"chat", hidden with "none" (default: after). Depth: injection depth for the prompt (default: 4). Role: role for in-chat injections (default: system). Scan: include injection content into World Info scans (default: false). Hidden injects in "none" position are not inserted into the prompt but can be used for triggering WI entries. Returns the injection ID.`,
    })); }

function register_listinjects() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'listinjects',
        callback: listInjectsCallback,
        helpString: t`Lists all script injections for the current chat. Displays injects in a popup by default. Use the <code>return</code> argument to change the return type.`,
        returns: t`Optionally the JSON object of script injections`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`The way how you want the return value to be provided`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'popup-html',
                enumList: slashCommandReturnHelper.enumList({ allowPipe: false, allowObject: true, allowChat: true, allowPopup: true, allowTextVersion: false }),
                forceEnum: true,
            }),
        ],
    })); }

function register_flushinject() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'flushinject',
        aliases: ['flushinjects'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`injection ID or a variable name pointing to ID`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
                enumProvider: commonEnumProviders.injects,
            }),
        ],
        callback: flushInjectsCallback,
        helpString: t`Removes a script injection for the current chat. If no ID is provided, removes all script injections.`,
    })); }

function register_tokens() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokens',
        callback: async (_, text) => {
            if (text instanceof SlashCommandClosure || Array.isArray(text)) throw new Error(t`Unnamed argument cannot be a closure for command /tokens`);
            return String(await getTokenCountAsync(text));
        },
        returns: t`number of tokens`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: t`Counts the number of tokens in the provided text.`,
    })); }

function register_upper() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'upper',
        aliases: ['uppercase', 'to-upper'],
        callback: (_, text) => typeof text === 'string' ? text.toUpperCase() : '',
        returns: t`uppercase string`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to affect`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: t`Converts the provided string to uppercase.`,
    })); }

function register_lower() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lower',
        aliases: ['lowercase', 'to-lower'],
        callback: (_, text) => typeof text === 'string' ? text.toLowerCase() : '',
        returns: t`lowercase string`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to affect`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: t`Converts the provided string to lowercase.`,
    })); }

function register_substr() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'substr',
        aliases: ['substring'],
        callback: (arg, text) => typeof text === 'string' ? text.slice(...[Number(arg.start), arg.end && Number(arg.end)]) : '',
        returns: t`substring`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'start', t`start index`, [ARGUMENT_TYPE.NUMBER], false, false,
            ),
            new SlashCommandNamedArgument(
                'end', t`end index`, [ARGUMENT_TYPE.NUMBER], false, false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to affect`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: `
            <div>
                ${t`Extracts text from the provided string.`}
            </div>
            <div>
                ${t`If <code>start</code> is omitted, it's treated as 0.<br />`}
                ${t`If <code>start</code> < 0, the index is counted from the end of the string.<br />`}
                ${t`If <code>start</code> >= the string's length, an empty string is returned.<br />`}
                ${t`If <code>end</code> is omitted, or if <code>end</code> >= the string's length, extracts to the end of the string.<br />`}
                ${t`If <code>end</code> < 0, the index is counted from the end of the string.<br />`}
                ${t`If <code>end</code> <= <code>start</code> after normalizing negative values, an empty string is returned.`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <pre>/let x The morning is upon us.     ||                                     </pre>
                <pre>/substr start=-3 {{var::x}}         | /echo  |/# us.                    ||</pre>
                <pre>/substr start=-3 end=-1 {{var::x}}  | /echo  |/# us                     ||</pre>
                <pre>/substr end=-1 {{var::x}}           | /echo  |/# The morning is upon us ||</pre>
                <pre>/substr start=4 end=-1 {{var::x}}   | /echo  |/# morning is upon us     ||</pre>
            </div>
        `,
    })); }

function register_chat_reload() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'chat-reload',
        helpString: t`Reloads the current chat.`,
        callback: async () => {
            await reloadCurrentChat();
            return '';
        },
    })); }

function register_replace() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'replace',
        aliases: ['re'],
        callback: (async ({ mode = 'literal', pattern, replacer = '' }, text) => {
            if (!pattern) {
                throw new Error(t`Argument of 'pattern=' cannot be empty`);
            }
            text = text.toString();
            pattern = pattern.toString();
            replacer = replacer.toString();
            switch (mode) {
                case 'literal':
                    return text.replaceAll(pattern, replacer);
                case 'regex':
                    return text.replace(regexFromString(pattern), replacer);
                default:
                    throw new Error(t`Invalid '/replace mode=' argument specified!`);
            }
        }),
        returns: t`replaced text`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: t`Replaces occurrence(s) of a pattern`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'literal',
                enumList: ['literal', 'regex'],
            }),
            new SlashCommandNamedArgument(
                'pattern', t`pattern to search with`, [ARGUMENT_TYPE.STRING], true, false,
            ),
            new SlashCommandNamedArgument(
                'replacer', t`replacement text for matches`, [ARGUMENT_TYPE.STRING], false, false, '',
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to affect`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: `
            <div>
                ${t`Replaces text within the provided string based on the pattern.`}
            </div>
            <div>
                ${t`If <code>mode</code> is <code>literal</code> (or omitted), <code>pattern</code> is a literal search string (case-sensitive).<br />`}
                ${t`If <code>mode</code> is <code>regex</code>, <code>pattern</code> is parsed as an ECMAScript Regular Expression.<br />`}
                ${t`The <code>replacer</code> replaces based on the <code>pattern</code> in the input text.<br />`}
                ${t`If <code>replacer</code> is omitted, the replacement(s) will be an empty string.<br />`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <pre><code class="language-stscript">/let x Blue house and blue car ||                                                                        </code></pre>
                <pre><code class="language-stscript">/replace pattern="blue" {{var::x}}                                | /echo  |/# Blue house and  car     ||</code></pre>
                <pre><code class="language-stscript">/replace pattern="blue" replacer="red" {{var::x}}                 | /echo  |/# Blue house and red car  ||</code></pre>
                <pre><code class="language-stscript">/replace mode=regex pattern="/blue/i" replacer="red" {{var::x}}   | /echo  |/# red house and blue car  ||</code></pre>
                <pre><code class="language-stscript">/replace mode=regex pattern="/blue/gi" replacer="red" {{var::x}}  | /echo  |/# red house and red car   ||</code></pre>
            </div>
        `,
    })); }

function register_test() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'test',
        callback: (({ pattern }, text) => {
            if (!pattern) {
                throw new Error(t`Argument of 'pattern=' cannot be empty`);
            }
            const re = regexFromString(pattern.toString());
            if (!re) {
                throw new Error(t`The value of 'pattern' argument is not a valid regular expression.`);
            }
            return JSON.stringify(re.test(text.toString()));
        }),
        returns: 'true | false',
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'pattern', t`pattern to find`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to test`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: `
            <div>
                ${t`Tests text for a regular expression match.`}
            </div>
            <div>
                ${t`Returns <code>true</code> if the match is found, <code>false</code> otherwise.`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <pre><code class="language-stscript">/let x Blue house and green car                         ||</code></pre>
                <pre><code class="language-stscript">/test pattern="green" {{var::x}}    | /echo  |/# true   ||</code></pre>
                <pre><code class="language-stscript">/test pattern="blue" {{var::x}}     | /echo  |/# false  ||</code></pre>
                <pre><code class="language-stscript">/test pattern="/blue/i" {{var::x}}  | /echo  |/# true   ||</code></pre>
            </div>
        `,
    })); }

function register_match() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'match',
        callback: (({ pattern }, text) => {
            if (!pattern) {
                throw new Error(t`Argument of 'pattern=' cannot be empty`);
            }
            const re = regexFromString(pattern.toString());
            if (!re) {
                throw new Error(t`The value of 'pattern' argument is not a valid regular expression.`);
            }
            if (re.flags.includes('g')) {
                return JSON.stringify([...text.toString().matchAll(re)]);
            } else {
                const match = text.toString().match(re);
                return match ? JSON.stringify(match) : '';
            }
        }),
        returns: t`group array for each match`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'pattern', t`pattern to find`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to match against`, [ARGUMENT_TYPE.STRING], true, false,
            ),
        ],
        helpString: `
            <div>
                ${t`Retrieves regular expression matches in the given text`}
            </div>
            <div>
                ${t`Returns an array of groups (with the first group being the full match). If the regex contains the global flag (i.e. <code>/g</code>), multiple nested arrays are returned for each match. If the regex is global, returns <code>[]</code> if no matches are found, otherwise it returns an empty string.`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <pre><code class="language-stscript">/let x color_green green lamp color_blue                                                                            ||</code></pre>
                <pre><code class="language-stscript">/match pattern="green" {{var::x}}            | /echo  |/# [ "green" ]                                               ||</code></pre>
                <pre><code class="language-stscript">/match pattern="color_(\\w+)" {{var::x}}      | /echo  |/# [ "color_green", "green" ]                                ||</code></pre>
                <pre><code class="language-stscript">/match pattern="/color_(\\w+)/g" {{var::x}}   | /echo  |/# [ [ "color_green", "green" ], [ "color_blue", "blue" ] ]  ||</code></pre>
                <pre><code class="language-stscript">/match pattern="orange" {{var::x}}           | /echo  |/#                                                           ||</code></pre>
                <pre><code class="language-stscript">/match pattern="/orange/g" {{var::x}}        | /echo  |/# []                                                        ||</code></pre>
            </div>
        `,
    })); }

function register_array_wrap() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'array-wrap',
        aliases: ['list-wrap'],
        returns: t`unnamed argument value wrapped into an array`,
        helpString: t`Wraps a single unnamed argument into an array if it's not already an array. If the value is an empty string, returns an empty array.`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'stringify',
                description: t`Whether JSON primitives (numbers, booleans, nulls) should be treated as strings, i.e. ["null"] when stringify=true vs. [null] when stringify=false.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`value`,
                acceptsMultiple: false,
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.DICTIONARY, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.LIST],
            }),
        ],
        callback: (args, value) => {
            // Closures are not supported
            if (value instanceof SlashCommandClosure) {
                throw new SlashCommandExecutionError(t`Closures are not supported as unnamed arguments for /array-wrap. Did you forget to call the closure with parentheses?`);
            }

            // Multiple unnamed arguments are not supported since acceptsMultiple is false, but check just in case
            if (Array.isArray(value)) {
                throw new SlashCommandExecutionError(t`/array-wrap does not support multiple unnamed arguments.`);
            }

            // Empty string - empty arrays
            if (value === '') {
                return JSON.stringify([]);
            }

            try {
                // If the value is a valid JSON string, parse it
                const parsedValue = JSON.parse(value);

                // Already an array - return as-is
                if (Array.isArray(parsedValue)) {
                    return value;
                }

                // If it's an object, wrap it into an array and stringify
                if (typeof parsedValue === 'object' && parsedValue !== null) {
                    return JSON.stringify([parsedValue]);
                }

                // For primitive values, check if we should take the parsed or original value based on the stringify argument
                const isJsonPrimitive = parsedValue === null || ['string', 'number', 'boolean'].includes(typeof parsedValue);
                if (isJsonPrimitive && isFalseBoolean(String(args?.stringify?.toString()))) {
                    return JSON.stringify([parsedValue]);
                }

                // Wrap the original value (string, number, boolean) into an array, preserving quotes for strings
                return JSON.stringify([value]);
            } catch {
                // Not a valid JSON string - wrap the original value
                return JSON.stringify([value]);
            }
        },
    })); }

function register_array_unwrap() { SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'array-unwrap',
        aliases: ['list-unwrap'],
        returns: t`unnamed argument value unwrapped from an array`,
        helpString: t`Unwraps the first element of an array provided as an unnamed argument. If the value is not an array, returns the value as-is. If the array is empty, returns an empty string.`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`value`,
                acceptsMultiple: false,
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.DICTIONARY, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.LIST],
            }),
        ],
        callback: (_args, value) => {
            // Closures are not supported
            if (value instanceof SlashCommandClosure) {
                throw new SlashCommandExecutionError(t`Closures are not supported as unnamed arguments for /array-unwrap. Did you forget to call the closure with parentheses?`);
            }

            // Multiple unnamed arguments are not supported since acceptsMultiple is false, but check just in case
            if (Array.isArray(value)) {
                throw new SlashCommandExecutionError(t`/array-unwrap does not support multiple unnamed arguments.`);
            }

            try {
                // If the value is a JSON array, get the first element
                const parsed = JSON.parse(value);

                if (Array.isArray(parsed)) {
                    const unwrappedValue = parsed?.[0] ?? '';

                    // If the first element is null or undefined, return an empty string
                    if (unwrappedValue === null || unwrappedValue === undefined) {
                        return '';
                    }

                    // If the first element is an object, stringify it.
                    if (typeof unwrappedValue === 'object') {
                        return JSON.stringify(unwrappedValue);
                    }

                    // Otherwise, return it as a string.
                    return String(unwrappedValue);
                }
                return value;
            } catch {
                // Not a valid JSON - return as-is
                return value;
            }
        },
    })); }

function setInputCallback(_, value) {
    $('#send_textarea').val(value || '')[0].dispatchEvent(new Event('input', { bubbles: true }));
    return value;
}

function trimStartCallback(_, value) {
    if (!value) {
        return '';
    }

    return trimToStartSentence(value);
}

function trimEndCallback(_, value) {
    if (!value) {
        return '';
    }

    return trimToEndSentence(value);
}

async function getMessagesCallback(args, value) {
    const includeNames = !isFalseBoolean(args?.names);
    const includeHidden = isTrueBoolean(args?.hidden);
    const role = args?.role;
    const range = stringToRange(value, 0, chat.length - 1);

    if (!range) {
        console.warn(`WARN: Invalid range provided for /messages command: ${value}`);
        return '';
    }

    const filterByRole = (mes) => {
        if (!role) {
            return true;
        }

        const isNarrator = mes.extra?.type === system_message_types.NARRATOR;

        if (role === 'system') {
            return isNarrator && !mes.is_user;
        }

        if (role === 'assistant') {
            return !isNarrator && !mes.is_user;
        }

        if (role === 'user') {
            return !isNarrator && mes.is_user;
        }

        throw new Error(t`Invalid role provided. Expected one of: system, assistant, user. Got: ${role}`);
    };

    const processMessage = async (mesId) => {
        const msg = chat[mesId];
        if (!msg) {
            console.warn(`WARN: No message found with ID ${mesId}`);
            return null;
        }

        if (role && !filterByRole(msg)) {
            console.debug(`/messages: Skipping message with ID ${mesId} due to role filter`);
            return null;
        }

        if (!includeHidden && msg.is_system) {
            console.debug(`/messages: Skipping hidden message with ID ${mesId}`);
            return null;
        }

        return includeNames ? `${msg.name}: ${msg.mes}` : msg.mes;
    };

    const messagePromises = [];

    for (let rInd = range.start; rInd <= range.end; ++rInd)
        messagePromises.push(processMessage(rInd));

    const messages = await Promise.all(messagePromises);

    return messages.filter(m => m !== null).join('\n\n');
}

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
export function registerDefaultCommands(){register_run();register_abort();register_delay();register_pass();register_echo();register_upper();register_lower();register_substr();register_replace();register_test();register_match();register_setinput();register_messages();register_array_wrap();register_array_unwrap();register_trimstart();register_trimend();register_stop();register_chat_reload();register_forcesave();register_tokens();register_input();register_popup();register_buttons();register_inject();register_listinjects();register_flushinject();}

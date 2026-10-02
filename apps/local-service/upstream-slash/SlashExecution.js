/*! Adapted from SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9. AGPL-3.0-only. See slash-upstream.json and THIRD_PARTY_NOTICES.md. */
import { toastr } from '/lib.js';
import { t } from '/scripts/i18n.js';
import { callGenericPopup,POPUP_TYPE } from '/scripts/popup.js';
import { SlashCommandParser } from './SlashCommandParser.js';
import { SlashCommandAbortController } from './SlashCommandAbortController.js';
import { SlashCommandParserError } from './SlashCommandParserError.js';
import { SlashCommandExecutionError } from './SlashCommandExecutionError.js';
import { SlashCommandClosureResult } from './SlashCommandClosureResult.js';
const parser = new SlashCommandParser();
export async function executeSlashCommandsWithOptions(text, options = {}) {
    if (!text) {
        return null;
    }
    options = Object.assign({
        handleParserErrors: true,
        scope: null,
        handleExecutionErrors: false,
        parserFlags: null,
        abortController: null,
        debugController: null,
        onProgress: null,
        source: null,
    }, options);

    let closure;
    try {
        closure = parser.parse(text, true, options.parserFlags, options.abortController ?? new SlashCommandAbortController());
        closure.scope.parent = options.scope;
        closure.onProgress = options.onProgress;
        closure.debugController = options.debugController;
        closure.source = options.source;
    } catch (e) {
        if (options.handleParserErrors && e instanceof SlashCommandParserError) {
            /**@type {SlashCommandParserError}*/
            const ex = e;
            const toast = `
                <div>${ex.message}</div>
                <div>${t`Line`}: ${ex.line} ${t`Column`}: ${ex.column}</div>
                <pre style="text-align:left;">${ex.hint}</pre>
                `;
            const clickHint = `<p>${t`Click to see details`}</p>`;
            toastr.error(
                `${toast}${clickHint}`,
                'SlashCommandParserError',
                { escapeHtml: false, timeOut: 10000, onclick: () => callGenericPopup(toast, POPUP_TYPE.TEXT, '', { allowHorizontalScrolling: true, allowVerticalScrolling: true }) },
            );
            const result = new SlashCommandClosureResult();
            return result;
        } else {
            throw e;
        }
    }

    try {
        const result = await closure.execute();
        if (result.isAborted && !result.isQuietlyAborted) {
            toastr.warning(result.abortReason, t`Command execution aborted`);
            closure.abortController.signal.isQuiet = true;
        }
        return result;
    } catch (e) {
        if (options.handleExecutionErrors) {
            if (e instanceof SlashCommandExecutionError) {
                /**@type {SlashCommandExecutionError}*/
                const ex = e;
                const toast = `
                    <div>${ex.message}</div>
                    <div>Line: ${ex.line} Column: ${ex.column}</div>
                    <pre style="text-align:left;">${ex.hint}</pre>
                    `;
                const clickHint = '<p>Click to see details</p>';
                toastr.error(
                    `${toast}${clickHint}`,
                    'SlashCommandExecutionError',
                    { escapeHtml: false, timeOut: 10000, onclick: () => callGenericPopup(toast, POPUP_TYPE.TEXT, '', { allowHorizontalScrolling: true, allowVerticalScrolling: true }) },
                );
            } else {
                toastr.error(e.message);
            }
            const result = new SlashCommandClosureResult();
            result.isError = true;
            result.errorMessage = e.message;
            return result;
        } else {
            throw e;
        }
    }
}

export async function executeSlashCommands(text, handleParserErrors = true, scope = null, handleExecutionErrors = false, parserFlags = null, abortController = null, onProgress = null) {
    return executeSlashCommandsWithOptions(text, {
        handleParserErrors,
        scope,
        handleExecutionErrors,
        parserFlags,
        abortController,
        onProgress,
    });
}
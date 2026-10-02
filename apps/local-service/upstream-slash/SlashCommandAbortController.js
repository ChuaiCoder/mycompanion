/*! Adapted from SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9. AGPL-3.0-only. See slash-upstream.json and THIRD_PARTY_NOTICES.md. */
import { AbstractEventTarget } from './AbstractEventTarget.js';

export class SlashCommandAbortController extends AbstractEventTarget {
    /**@type {SlashCommandAbortSignal}*/ signal;


    constructor() {
        super();
        this.signal = new SlashCommandAbortSignal();
    }
    abort(reason = 'No reason.', isQuiet = false) {
        this.signal.isQuiet = isQuiet;
        this.signal.aborted = true;
        this.signal.reason = reason;
        this.dispatchEvent(new Event('abort'));
    }
    pause(reason = 'No reason.') {
        this.signal.paused = true;
        this.signal.reason = reason;
        this.dispatchEvent(new Event('pause'));
    }
    continue(reason = 'No reason.') {
        this.signal.paused = false;
        this.signal.reason = reason;
        this.dispatchEvent(new Event('continue'));
    }
}

export class SlashCommandAbortSignal {
    /**@type {boolean}*/ isQuiet = false;
    /**@type {boolean}*/ paused = false;
    /**@type {boolean}*/ aborted = false;
    /**@type {string}*/ reason = null;
}

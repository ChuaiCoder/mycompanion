/*! Adapted from SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9. AGPL-3.0-only. See slash-upstream.json and THIRD_PARTY_NOTICES.md. */
/**
 * @abstract
 * @implements {EventTarget}
 */
export class AbstractEventTarget {
    constructor() {
        this.listeners = {};
    }

    addEventListener(type, callback, _options) {
        if (!this.listeners[type]) {
            this.listeners[type] = [];
        }
        this.listeners[type].push(callback);
    }

    dispatchEvent(event) {
        if (!this.listeners[event.type] || this.listeners[event.type].length === 0) {
            return true;
        }
        this.listeners[event.type].forEach(listener => {
            listener(event);
        });
        return true;
    }

    removeEventListener(type, callback, _options) {
        if (!this.listeners[type]) {
            return;
        }
        const index = this.listeners[type].indexOf(callback);
        if (index !== -1) {
            this.listeners[type].splice(index, 1);
        }
    }
}

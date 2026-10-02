/*! Adapted from SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9. AGPL-3.0-only. See slash-upstream.json and THIRD_PARTY_NOTICES.md. */
export class SlashCommandBreakController {
    /**@type {boolean} */ isBreak = false;

    break() {
        this.isBreak = true;
    }
}

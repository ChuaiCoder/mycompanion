/*! Adapted from SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9. AGPL-3.0-only. See slash-upstream.json and THIRD_PARTY_NOTICES.md. */
import { chat_metadata,chat,extension_prompt_roles } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { SlashCommandEnumValue,enumTypes } from './SlashCommandEnumValue.js';
export const enumIcons = {
    default: '◊',

    // Variables
    variable: '𝑥',
    localVariable: 'L',
    globalVariable: 'G',
    scopeVariable: 'S',

    // Common types
    character: '👤',
    group: '🧑‍🤝‍🧑',
    persona: '🧙‍♂️',
    qr: 'QR',
    closure: '𝑓',
    macro: '{{',
    tag: '🏷️',
    world: '🌐',
    preset: '⚙️',
    file: '📄',
    message: '💬',
    reasoning: '💡',
    voice: '🎤',
    server: '🖥️',
    popup: '🗔',
    image: '🖼️',
    video: '🎥',
    key: '🔑',
    spinner: '♻️',
    stop: '🛑',

    true: '✔️',
    false: '❌',
    null: '🚫',
    undefined: '❓',

    // Value types
    boolean: '🔲',
    string: '📝',
    number: '1️⃣',
    array: '[]',
    enum: '📚',
    dictionary: '{}',

    // Roles
    system: '⚙️',
    user: '👤',
    assistant: '🤖',

    // WI Icons
    constant: '🔵',
    normal: '🟢',
    disabled: '❌',
    vectorized: '🔗',

    /**
     * Returns the appropriate state icon based on a boolean
     *
     * @param {boolean} state - The state to determine the icon for
     * @returns {string} The corresponding state icon
     */
    getStateIcon: (state) => {
        return state ? enumIcons.true : enumIcons.false;
    },

    /**
     * Returns the appropriate WI icon based on the entry
     *
     * @param {Object} entry - WI entry
     * @returns {string} The corresponding WI icon
     */
    getWiStatusIcon: (entry) => {
        if (entry.constant) return enumIcons.constant;
        if (entry.disable) return enumIcons.disabled;
        if (entry.vectorized) return enumIcons.vectorized;
        return enumIcons.normal;
    },

    /**
     * Returns the appropriate icon based on the role
     *
     * @param {extension_prompt_roles} role - The role to get the icon for
     * @returns {string} The corresponding icon
     */
    getRoleIcon: (role) => {
        switch (role) {
            case extension_prompt_roles.SYSTEM: return enumIcons.system;
            case extension_prompt_roles.USER: return enumIcons.user;
            case extension_prompt_roles.ASSISTANT: return enumIcons.assistant;
            default: return enumIcons.default;
        }
    },

    /**
     * A function to get the data type icon
     *
     * @param {string} type - The type of the data
     * @returns {string} The corresponding data type icon
     */
    getDataTypeIcon: (type) => {
        // Remove possible nullable types definition to match type icon
        type = type.replace(/\?$/, '');
        return enumIcons[type] ?? enumIcons.default;
    },
};
export const commonEnumProviders = {
boolean: (mode = 'trueFalse') => () => {
        switch (mode) {
            case 'onOff': return [new SlashCommandEnumValue('on', null, 'macro', enumIcons.true), new SlashCommandEnumValue('off', null, 'macro', enumIcons.false)];
            case 'onOffToggle': return [new SlashCommandEnumValue('on', null, 'macro', enumIcons.true), new SlashCommandEnumValue('off', null, 'macro', enumIcons.false), new SlashCommandEnumValue('toggle', null, 'macro', enumIcons.boolean)];
            case 'trueFalse': return [new SlashCommandEnumValue('true', null, 'macro', enumIcons.true), new SlashCommandEnumValue('false', null, 'macro', enumIcons.false)];
            default: throw new Error(`Invalid boolean enum provider mode: ${mode}`);
        }
    },
variables: (...type) => (_, scope) => {
        const types = type.flat();
        const isAll = types.includes('all');
        return [
            ...isAll || types.includes('scope') ? scope.allVariableNames.map(name => new SlashCommandEnumValue(name, null, enumTypes.variable, enumIcons.scopeVariable)) : [],
            ...isAll || types.includes('local') ? Object.keys(chat_metadata.variables ?? []).map(name => new SlashCommandEnumValue(name, null, enumTypes.name, enumIcons.localVariable)) : [],
            ...isAll || types.includes('global') ? Object.keys(extension_settings.variables.global ?? []).map(name => new SlashCommandEnumValue(name, null, enumTypes.macro, enumIcons.globalVariable)) : [],
        ].filter((item, idx, list) => idx == list.findIndex(it => it.value == item.value));
    },
numbersAndVariables: (executor, scope) => [
        ...commonEnumProviders.variables('all')(executor, scope),
        new SlashCommandEnumValue(
            'any variable name',
            null,
            enumTypes.variable,
            enumIcons.variable,
            (input) => /^\w*$/.test(input),
            (input) => input,
        ),
        new SlashCommandEnumValue(
            'any number',
            null,
            enumTypes.number,
            enumIcons.number,
            (input) => input == '' || !Number.isNaN(Number(input)),
            (input) => input,
        ),
    ],
messages: ({ allowIdAfter = false, allowVars = false } = {}) => (executor, scope) => {
        const nameFilter = executor.namedArgumentList.find(it => it.name == 'name')?.value || '';
        return [
            ...chat.map((message, index) => new SlashCommandEnumValue(String(index), `${message.name}: ${message.mes}`, enumTypes.number, message.is_user ? enumIcons.user : message.is_system ? enumIcons.system : enumIcons.assistant)).filter(value => !nameFilter || value.description.startsWith(`${nameFilter}:`)),
            ...allowIdAfter ? [new SlashCommandEnumValue(String(chat.length), '>> After Last Message >>', enumTypes.enum, '➕')] : [],
            ...allowVars ? commonEnumProviders.variables('all')(executor, scope) : [],
        ];
    },
types: () => [
        new SlashCommandEnumValue('string', null, enumTypes.type, enumIcons.string),
        new SlashCommandEnumValue('number', null, enumTypes.type, enumIcons.number),
        new SlashCommandEnumValue('boolean', null, enumTypes.type, enumIcons.boolean),
        new SlashCommandEnumValue('array', null, enumTypes.type, enumIcons.array),
        new SlashCommandEnumValue('object', null, enumTypes.type, enumIcons.dictionary),
        new SlashCommandEnumValue('null', null, enumTypes.type, enumIcons.null),
        new SlashCommandEnumValue('undefined', null, enumTypes.type, enumIcons.undefined),
    ]
};

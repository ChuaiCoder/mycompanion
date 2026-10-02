// Extracted CHARACTER definitions from SillyTavern 1.19.0, commit 7e8663cd9c184a550b37238218bdd32c6efc68e9.
// SPDX-License-Identifier: AGPL-3.0-only
// Adaptation: dialogue parsing and instruct formatting are supplied by this invocation's host.
// Accessors retain lazy card getters; no global application state is read here.
import { MacroRegistry, MacroCategory, MacroValueType } from '../engine/MacroRegistry.js';

export function registerCharacterMacros() {
    // Character card field macros (from MacroEnv.character)
    MacroRegistry.registerMacro('charPrompt', {
        category: MacroCategory.CHARACTER,
        description: 'The character\'s Main Prompt override.',
        returns: 'Character Main Prompt override.',
        handler: ({ env }) => env.character.charPrompt ?? '',
    });

    MacroRegistry.registerMacro('charInstruction', {
        category: MacroCategory.CHARACTER,
        description: 'The character\'s Post-History Instructions override.',
        returns: 'Character Post-History Instructions override.',
        handler: ({ env }) => env.character.charInstruction ?? '',
    });

    MacroRegistry.registerMacro('charDescription', {
        aliases: [{ alias: 'description' }],
        category: MacroCategory.CHARACTER,
        description: 'The character\'s description.',
        returns: 'Character description.',
        handler: ({ env }) => env.character.description ?? '',
    });

    MacroRegistry.registerMacro('charPersonality', {
        aliases: [{ alias: 'personality' }],
        category: MacroCategory.CHARACTER,
        description: 'The character\'s personality.',
        returns: 'Character personality.',
        handler: ({ env }) => env.character.personality ?? '',
    });

    MacroRegistry.registerMacro('charScenario', {
        aliases: [{ alias: 'scenario' }],
        category: MacroCategory.CHARACTER,
        description: 'The character\'s scenario.',
        returns: 'Character scenario.',
        handler: ({ env }) => env.character.scenario ?? '',
    });

    MacroRegistry.registerMacro('persona', {
        category: MacroCategory.CHARACTER,
        description: 'Your current Persona description.',
        returns: 'Persona description.',
        handler: ({ env }) => env.character.persona ?? '',
    });

    MacroRegistry.registerMacro('mesExamplesRaw', {
        category: MacroCategory.CHARACTER,
        description: 'Unformatted dialogue examples from the character card.',
        returns: 'Unformatted dialogue examples.',
        handler: ({ env }) => env.character.mesExamplesRaw ?? '',
    });

    MacroRegistry.registerMacro('mesExamples', {
        category: MacroCategory.CHARACTER,
        description: 'The character\'s dialogue examples, formatted for instruct mode when enabled.',
        returns: 'Formatted dialogue examples.',
        handler: ({ env }) => {
            const raw = env.character.mesExamplesRaw ?? '';
            if (!raw) return '';

            const isInstruct = env.extra.isInstruct === true;
            const parseMesExamples = env.extra.parseMesExamples;
            if (typeof parseMesExamples !== 'function') {
                throw new Error('Dialogue example parsing is not bound in this macro context');
            }
            const parsed = parseMesExamples(raw, isInstruct);

            if (!Array.isArray(parsed) || parsed.length === 0) {
                return '';
            }
            if (!isInstruct) {
                return parsed.join('');
            }

            const formatInstructModeExamples = env.extra.formatInstructModeExamples;
            if (typeof formatInstructModeExamples !== 'function') {
                throw new Error('Instruct example formatting is not bound in this macro context');
            }
            const formatted = formatInstructModeExamples(parsed, env.names.user, env.names.char);
            return Array.isArray(formatted) ? formatted.join('') : '';
        },
    });

    MacroRegistry.registerMacro('charDepthPrompt', {
        category: MacroCategory.CHARACTER,
        description: 'The character\'s @ Depth Note.',
        returns: 'Character @ Depth Note.',
        handler: ({ env }) => env.character.charDepthPrompt ?? '',
    });

    MacroRegistry.registerMacro('charCreatorNotes', {
        aliases: [{ alias: 'creatorNotes' }],
        category: MacroCategory.CHARACTER,
        description: 'Creator notes from the character card.',
        returns: 'Creator notes.',
        handler: ({ env }) => env.character.creatorNotes ?? '',
    });

    MacroRegistry.registerMacro('charFirstMessage', {
        aliases: [{ alias: 'greeting' }],
        category: MacroCategory.CHARACTER,
        unnamedArgs: [
            {
                name: 'index',
                optional: true,
                defaultValue: '0',
                type: MacroValueType.INTEGER,
                description: '0-based index. 0 (default) returns the main greeting, 1 and up return alternate greetings.',
            },
        ],
        description: 'The character\'s first message / greeting. Optionally specify an index to access alternate greetings.',
        returns: 'Character greeting at the given index, or empty string if out of bounds.',
        exampleUsage: ['{{greeting}}', '{{greeting::0}}', '{{greeting::1}}'],
        handler: ({ env, unnamedArgs: [index] }) => {
            const i = Number(index ?? 0);
            if (i === 0) return env.character.firstMessage ?? '';
            const altGreetings = env.character.alternateGreetings;
            if (!Array.isArray(altGreetings)) return '';
            return altGreetings[i - 1] ?? '';
        },
    });

    // Character version macros (legacy variants and documented {{charVersion}})
    MacroRegistry.registerMacro('charVersion', {
        aliases: [
            { alias: 'version', visible: false }, // Legacy alias
            { alias: 'char_version', visible: false }, // Legacy underscore variant
        ],
        category: MacroCategory.CHARACTER,
        description: 'The character\'s version number.',
        returns: 'Character version number.',
        handler: ({ env }) => env.character.version ?? '',
    });

}

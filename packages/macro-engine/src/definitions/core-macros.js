// Extracted utility/control-flow definitions from SillyTavern 1.19.0.
// SPDX-License-Identifier: AGPL-3.0-only
// Runtime state, random/dice and outlets are supplied separately by the host.
import { MacroRegistry, MacroCategory, MacroValueType } from '../engine/MacroRegistry.js';
import { MACRO_VARIABLE_SHORTHAND_PATTERN } from '../engine/MacroLexer.js';
import { MacroParser } from '../engine/MacroParser.js';
import { MacroCstWalker } from '../engine/MacroCstWalker.js';
import { isFalseBoolean } from '../boolean.js';
export const ELSE_MARKER = '\u0000\u001FELSE\u001F\u0000';
export function registerCoreMacros() {
    // {{space}} -> ' '
    MacroRegistry.registerMacro('space', {
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'count',
                optional: true,
                defaultValue: '1',
                type: MacroValueType.INTEGER,
                description: 'Number of spaces to insert.',
            },
        ],
        description: 'Returns one or more spaces. One space by default, more if the count argument is specified.',
        returns: 'One or more spaces.',
        exampleUsage: ['{{space}}', '{{space::4}}'],
        handler: ({ unnamedArgs: [count] }) => ' '.repeat(Number(count ?? 1)),
    });

    // {{newline}} -> '\n'
    MacroRegistry.registerMacro('newline', {
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'count',
                optional: true,
                defaultValue: '1',
                type: MacroValueType.INTEGER,
                description: 'Number of newlines to insert.',
            },
        ],
        description: 'Inserts one or more newlines. One newline by default, more if the count argument is specified.',
        returns: 'One or more \\n.',
        exampleUsage: ['{{newline}}', '{{newline::2}}'],
        handler: ({ unnamedArgs: [count] }) => '\n'.repeat(Number(count ?? 1)),
    });

    // {{noop}} -> ''
    MacroRegistry.registerMacro('noop', {
        category: MacroCategory.UTILITY,
        description: 'Does nothing and produces an empty string.',
        returns: '',
        handler: () => '',
    });

    // {{trim}} -> macro will currently replace itself with itself. Trimming is handled in post-processing.
    // Scoped: {{trim}}content{{/trim}} -> trims whitespace from content (handled by engine auto-trim)
    MacroRegistry.registerMacro('trim', {
        category: MacroCategory.UTILITY,
        description: 'Trims whitespace. Non-scoped: trims newlines around the macro (post-processing). Scoped: returns the content (auto-trimmed by the engine).',
        unnamedArgs: [
            {
                name: 'content',
                description: 'Content to trim (when used as scoped macro)',
                optional: true,
            },
        ],
        returns: '',
        handler: ({ unnamedArgs: [content], isScoped }) => {
            // Scoped usage: return content (already auto-trimmed by the engine)
            if (isScoped) return content ?? '';
            // Non-scoped: return marker for post-processing regex
            return '{{trim}}';
        },
    });

    /**
     * Splits raw content on the first {{else}} macro at nesting depth 0.
     * Tracks scoped {{if}}/{{/if}} pairs to find the correct top-level else.
     * Only {{if}} with 1 argument (condition only) are considered scoped blocks.
     *
     * @param {string} content - The raw content to split
     * @returns {{ thenBranch: string, elseBranch: string | undefined }}
     */
    function splitOnTopLevelElse(content) {
        const { cst } = MacroParser.parseDocument(content);
        const macroNodes = /** @type {import('chevrotain').CstNode[]} */ (cst?.children?.macro || []);

        let depth = 0;
        for (const macroNode of macroNodes) {
            const info = MacroCstWalker.extractMacroInfo(macroNode);
            if (!info) continue;

            // Only track scoped {{if}} blocks (1 arg = condition only, expects {{/if}})
            // Inline {{if condition::content}} has 2 args and doesn't affect depth
            if (info.name === 'if' && !info.isClosing && info.argCount === 1) {
                depth++;
            } else if (info.name === 'if' && info.isClosing) {
                depth--;
            } else if (info.name === 'else' && depth === 0) {
                return {
                    thenBranch: content.slice(0, info.startOffset),
                    elseBranch: content.slice(info.endOffset + 1),
                };
            }
        }

        return { thenBranch: content, elseBranch: undefined };
    }

    // {{if condition}}content{{/if}} -> conditional content
    // {{if condition}}then-content{{else}}else-content{{/if}} -> conditional with else branch
    // {{if !condition}}content{{/if}} -> inverted conditional (negated)
    // Condition can be a macro name (resolved automatically), variable shorthand (.var or $var), or any value
    MacroRegistry.registerMacro('if', {
        category: MacroCategory.UTILITY,
        description: 'Conditional macro. Returns the content if the condition is truthy, otherwise returns nothing (or the else branch if present). Prefix the condition with ! to invert. If the condition is a registered macro name (without braces), it will be resolved first. Variable shorthands (.varname for local, $varname for global) are also supported.',
        unnamedArgs: [
            {
                name: 'condition',
                description: 'The condition to evaluate. Prefix with ! to invert. Can be a macro name (auto-resolved), variable shorthand (.var or $var), or a value. Falsy: empty string, "false", "off", "0".',
            },
            {
                name: 'content',
                description: 'The content to return if condition is truthy (typically provided as scoped content). May contain {{else}} to define an else branch.',
            },
        ],
        displayOverride: '{{if condition}}then{{else}}other{{/if}}',
        exampleUsage: [
            '{{if description}}# Description\n{{description}}{{/if}}',
            '{{if charVersion}}{{charVersion}}{{else}}No version{{/if}}',
            '{{if !personality}}No personality defined{{/if}}',
            '{{if {{getvar::showHeader}}}}# Header{{/if}}',
            '{{if .myvar}}Local var exists{{/if}}',
            '{{if $globalFlag}}Global flag is set{{/if}}',
        ],
        returns: 'The content if condition is truthy, else branch or empty string otherwise.',
        // Delay argument resolution so nested macros are only evaluated in the chosen branch
        delayArgResolution: true,
        handler: ({ unnamedArgs: [rawCondition, rawContent], flags, resolve, trimContent }) => {
            // With delayArgResolution: true, args contain raw (unresolved) text.
            // We resolve the condition first, then only resolve the chosen branch.

            // Check if the condition starts with ! for inversion
            let inverted = false;
            let condition = rawCondition;
            if (/^\s*!/.test(rawCondition)) {
                inverted = true;
                condition = rawCondition.replace(/^\s*!\s*/, '');
            }

            // Resolve the condition (may contain nested macros like {{getvar::x}})
            condition = resolve(condition);

            // Check if condition is a variable shorthand (.varname or $varname)
            // If so, resolve it using the appropriate variable macro
            const varShorthandRegex = new RegExp(`^([.$])(${MACRO_VARIABLE_SHORTHAND_PATTERN.source})$`);
            const varShorthandMatch = condition.match(varShorthandRegex);
            if (varShorthandMatch) {
                const [, prefix, varName] = varShorthandMatch;
                const varMacro = prefix === '.' ? 'getvar' : 'getglobalvar';
                condition = resolve(`{{${varMacro}::${varName}}}`);
            } else {
                // Check if condition is a registered macro name (without braces)
                // If so, resolve it first (only for macros that accept 0 required args)
                const macroDef = MacroRegistry.getPrimaryMacro(condition);
                if (macroDef && macroDef.minArgs === 0) {
                    condition = resolve(`{{${condition}}}`);
                }
            }

            // Check if condition is falsy: empty string or isFalseBoolean
            let isFalsy = condition === '' || isFalseBoolean(condition);
            if (inverted) isFalsy = !isFalsy;

            // Split raw content on {{else}} macro at the top nesting level
            // We need to track nesting depth to find the correct {{else}} for this if
            const { thenBranch, elseBranch } = splitOnTopLevelElse(rawContent);

            // Only resolve the chosen branch
            const chosenBranch = !isFalsy ? thenBranch : elseBranch;
            if (chosenBranch === undefined) {
                return '';
            }

            // Resolve nested macros in the chosen branch
            // Trim result unless # flag is set (preserveWhitespace)
            let result = resolve(chosenBranch);
            if (!flags.preserveWhitespace) {
                result = trimContent(result);
            }
            return result;
        },
    });

    // {{else}} -> marker for else branch inside {{if}} blocks
    // Only meaningful inside a scoped {{if}} macro
    MacroRegistry.registerMacro('else', {
        category: MacroCategory.UTILITY,
        description: 'Marks the else branch inside a scoped {{if}} block. Only works inside {{if}}...{{/if}}. If used outside, returns an invisible marker.',
        exampleUsage: [
            '{{if condition}}true branch{{else}}false branch{{/if}}',
        ],
        returns: 'Invisible marker (consumed by the enclosing {{if}} macro).',
        handler: () => ELSE_MARKER,
    });

    // String utilities
    MacroRegistry.registerMacro('reverse', {
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'value',
                type: MacroValueType.STRING,
                description: 'The string to reverse.',
            },
        ],
        description: 'Reverses the characters of the argument provided.',
        returns: 'Reversed string.',
        exampleUsage: ['{{reverse::I am Lana}}'],
        handler: ({ unnamedArgs: [value] }) => Array.from(value).reverse().join(''),
    });

    // Comment macro: {{// ...}} -> '' (consumes any arguments)
    MacroRegistry.registerMacro('//', {
        aliases: [{ alias: 'comment', visible: false }],
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'comment',
                type: MacroValueType.STRING,
                description: 'Any kind of text as comment. If you want multiline comments, consider using a scoped macro like {{//}}First\nSecond{{///}}.',
            },
        ],
        // list: true,         // We consume any arguments as if this is a list, but we'll ignore them in the handler anyway
        // strictArgs: false,  // and we also always remove it, even if the parsing might say it's invalid
        description: 'Comment macro that produces an empty string. Can be used for writing into prompt definitions, without being passed to the context.',
        returns: '',
        displayOverride: '{{// ...}}',
        exampleUsage: ['{{// This is a comment}}'],
        handler: () => '',
    });

}

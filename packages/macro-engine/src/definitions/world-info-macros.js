// Extracted from SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9.
// SPDX-License-Identifier: AGPL-3.0-only
// Bind the upstream outlet read to this invocation's prompt map.
import { MacroRegistry, MacroCategory } from '../engine/MacroRegistry.js';
export function registerWorldInfoMacros() {
  MacroRegistry.registerMacro('outlet', {
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'key',
                sampleValue: 'my-outlet-key',
                description: 'Outlet key.',
                type: 'string',
            },
        ],
        description: 'Returns the world info outlet prompt for a given outlet key.',
        returns: 'World info outlet prompt.',
        exampleUsage: ['{{outlet::character-achievements}}'],
        handler: ({ unnamedArgs: [outlet], env }) => {
            if (!outlet) return '';
            const value = env.extra.getOutletPrompt?.(outlet);
            return value || '';
        },
    });
}

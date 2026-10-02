# Shared macro engine

This package reuses the SillyTavern 1.19.0 lexer, parser, walker, registry, engine
flags and environment builder from commit `7e8663cd9c184a550b37238218bdd32c6efc68e9`, under
AGPL-3.0-only. `upstream.json` records the original file hashes. The source archive
includes these modified files, the build script, package lock and license texts.

Adaptations:

- Chevrotain imports target pinned npm version 13.2.0 instead of Tavern's lib.js.
- Boolean helpers and observable console diagnostics are host-independent.
- Variable shorthand reads its variable API from the invocation environment,
  replacing the global `SillyTavern.getContext()` dependency.
- The environment builder accepts a live host-state reader rather than importing
  application globals. Each host owns its instance; ordered providers and lazy
  character fields retain the upstream contract.
- Utility/control-flow definitions are extracted from core-macros.js. Host
  bindings in index.js supply names, budget/time values and variable operations.
- CHARACTER definitions are extracted from env-macros.js. Aliases, lazy property
  reads and typed greeting indices retain the upstream behavior. Dialogue examples
  use invocation-local host functions instead of application globals.
- The same ESM bundle is imported by the local service and served to extensions.
  No DOM, complete upstream application, account UI or third-party helper is bundled.

Existing profiles retain their legacy macro path. The standard
`power_user.experimental_macro_engine` flag selects the new engine in both native
prompt/world-info expansion and extension substitution. This is an integration
stage: not all built-in macro definitions or later PromptManager phases are
connected yet. Public assembly variable lifecycles now commit successful API
effects; native first-card stages precede world-info scanning. Native generation
drafts and browser stores share the same
project-owned variable operations. Browser callbacks are not serialized into the server registry.
These gaps must be resolved before the new engine becomes the default and before
claiming complete macro parity.

Build with `npm run build -w @mycompanion/macro-engine`. The containing workspace
build runs this before typechecking/testing the service. Tests execute the actual
compiled parser and real Electron module graph; changing the bundle requires a
rebuild. The full application license remains AGPL-3.0-only. Chevrotain and its
components retain Apache-2.0; full notices ship in the application notices file.

`mesExamplesRaw` returns the resolved card field directly. `mesExamples` calls
`env.extra.parseMesExamples(raw, isInstruct)` and joins its returned string array.
`isInstruct` is `env.extra.isInstruct === true`; Chat Completion hosts keep it false.
For an instruct invocation, the host also supplies
`env.extra.formatInstructModeExamples(parsed, env.names.user, env.names.char)`.
These bindings are read only when nonempty examples are requested. Empty parsing
results return an empty string. A missing required function produces the engine's
normal execution diagnostic and preserves the macro syntax; raw examples are never
silently substituted for formatted examples.

The upstream new-engine greeting accessor is `charFirstMessage`, alias `greeting`,
with index 0 for the main greeting and 1 onward for alternate greetings. No independent
`firstMes`, `alternateGreetings` or `charJailbreak` new-engine macro is introduced.
`charVersion` retains the hidden `version` and `char_version` aliases.

# SillyTavern prompt oracles

These AGPL-3.0-only verification scripts are the editable source used to produce the four frozen prompt fixtures under `apps/local-service/src/fixtures`. They extract the original function/class declarations without changing their bodies, execute them in a VM with explicit desktop host bindings, and compare complete messages, variables and each substitution call with the product implementation. Source hashes in `source-hashes.json` reject any upstream version other than the pinned 1.19.0 commit `7e8663cd9c184a550b37238218bdd32c6efc68e9`.

The source archive includes these scripts and frozen expected outputs. Obtain the upstream checkout separately; the full research cache is not part of the desktop release or source archive. Build the workspace before running an oracle:

```powershell
npm run build
node scripts/upstream-oracles/prompt-manager-upstream-oracle-20261002.mjs --upstream-dir C:/source/SillyTavern
node scripts/upstream-oracles/prompt-population-upstream-oracle-20261002.mjs --upstream-dir C:/source/SillyTavern
node scripts/upstream-oracles/prompt-lifecycle-upstream-oracle-20261002.mjs --upstream-dir C:/source/SillyTavern
node scripts/upstream-oracles/prompt-remaining-upstream-oracle-20261002.mjs --upstream-dir C:/source/SillyTavern
node scripts/upstream-oracles/prompt-persona-examples-upstream-oracle-20261003.mjs --upstream-dir C:/source/SillyTavern
```

Reports default to `.cache/reports`; `--report-dir` selects another directory. Verification does not replace fixtures. Pass `--write-fixtures` explicitly only after inspecting the actual upstream traces. Changes to expected call counts must come from those traces, never from product output. The legacy and population scripts also run when imported by the later oracles, so their reports are regenerated as dependencies.

Scope: single-character text Chat Completion preparation/population, macro call order, formatting, overrides, WI example placement, depth/role buckets, history and example admission, and variable effects. Experimental engine cases reuse the pinned shared macro interpreter and explicitly supplied host providers. The `personaDescription: ''` public desktop override uses an upstream host suppression adapter; it is not an upstream `preparePromptsForChatCompletion` parameter. Full-width speaker separators, safe ordinary WI trimming and product memory/command injection are separately documented desktop adaptations. Tools, media, groups and continuation are not covered or claimed equivalent.

The standalone `native-legacy-upstream-oracle-20261002.mjs` verifies real legacy eager card reads and supplies the declaration extractor to the prompt oracles.

`character-import.mjs` executes the fixed server's actual V1/Pygmalion/YAML import
functions and BYAF conversion with explicit file/avatar I/O stubs. Its six cases
produce `character-import-upstream-reference.json`; unknown-field preservation,
UUID identities, ISO dates and the upstream AI-only failure are documented host
differences. Use the same `--upstream-dir`, `--report-dir` and opt-in `--write-fixtures`
arguments. Included service tests consume this fixture without a research checkout.

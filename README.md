# MyCompanion

当前是独立 Windows 桌面项目，使用 Electron/React/Fastify/SQLite，扩展通过 Git URL 安装真实 JS/CSS。本轮已修复数据隔离、备份原子性、历史编辑派生状态和草稿重启恢复，并加入保存前短回复连接测试。完整清单仍在实施，见 [实施记录](docs/checklist-implementation.md) 和 [待完成清单](docs/project-todo.md)。

单角色文本 PromptManager 和浏览器/原生宏调用边界已通过固定上游对照与真实桌面专项。
角色卡可迁移 CHARX、PNG 资产、旧 JSON/YAML/BYAF，并编辑 JPEG/WebP 头像及裁剪。
`npm run package:win` 先生成内部候选；正式晋升使用 `npm run promote:release -- --candidate <candidate.json> --acceptance <acceptance.json>` 并验证同一 EXE/源码的全部证据。旧 `release` 中的唯一正式包尚未替换。未完成的原版助手全域、其他协议/生成模式、模型质量与真人新人验收不能由下面的历史测试数替代。

以下按时间记录历史阶段；当前状态以上述清单为准。

2026-10-02 character macro phases: native generation now prepares the complete
first card snapshot in Tavern order before world-info scanning. Public scan data
is used literally; legacy browser substitutions eagerly read cards, while the
new engine reads them lazily. Shared card definitions are adapted from the pinned
AGPL source with recorded hashes. Source checks pass 407 tests, typechecking and
build. Public assembly stays separate from native card preparation and preserves
explicit overrides. Full subsequent PromptManager phases and native card macro
bindings remain open; see [phase boundaries](docs/character-macro-phases.md).
The sole official EXE is unchanged; previous candidate results below apply only
to their frozen source. The complete Electron plugin suite and original Helper
macro/viewer source suite pass; the latter still records external fetch errors.
Frozen internal candidate `3a423ab2...` now passes the same portable EXE's
newcomer/macro (24 stages), original Helper viewer (6), scripts/scopes (8), and
UI Git URL installation/update (3) suites. Its 328-file corresponding source and
report hashes are recorded in the phase manifest. Product and verification code
match the archive; later documentation is listed separately. A public assembly
fallback still scans world info when both WI arguments are omitted; this gap is
reproduced and remains open alongside the later macro phases. No official release
replacement follows from these scoped results.

2026-10-02 public macro lifecycle: world-info and extension prompt assembly now
publish variable effects at their own successful API boundary, including public
dryRun calls; native previews remain read-only. Legacy browser/native rules share
one implementation. Missing metadata falls back to saved story state, and late
responses reject after story/branch changes. Unchanged extension chat saves now
preserve native message fields and timestamps. Source checks pass 388 tests plus
typechecking/build. Original Helper legacy/new streaming and nonstreaming macro
checks pass with viewer/scopes suites; see [current boundaries](docs/macro-api-lifecycle.md).
Internal candidate `82454edd...` passes the same EXE's newcomer/macro (24 stages),
original Helper viewer (6), scripts/scopes (8), and UI URL install/update (3)
acceptance suites. Stateful card/world-info evaluation order and remaining APIs
are still open. The sole official EXE is unchanged. The entries below describe earlier milestones.

2026-10-02 generation parameters: the public createGenerationParameters API,
native preflight and extension sending now share request construction. Extension
requests carry their own context limit and use the same final budget validation,
including tools and structured-output schemas. Original Helper streaming and
nonstreaming generation use the public API without fallback. A scope acceptance
run also exposed preset-library deletion on a no-op settings patch; that bug is
fixed with reproducing regressions. See [details](docs/generation-parameters.md).
Internal candidate `3b0238bb...` passes actual EXE newcomer/error-recovery and
macro checks, original Helper streaming/nonstreaming/PromptViewer, script scopes,
restart and Git URL installation/update. The official release is unchanged;
remaining macro lifecycle and protocol work stays open. Earlier candidates below
do not contain these changes.

2026-10-02 native macro state: normal/regenerate/quiet generation shares a
request-local variable draft across world-info scanning and prompt assembly.
Validated requests commit changed keys atomically; native previews/cancelled
preflight discard them. Browser stores receive committed deltas, and queued
settings patches preserve unrelated native writes. Browser and native variable
operations now use the same implementation. Source checks pass 366 tests.
Review fixes re-evaluate recursive world-info keywords, exclude unused prompt
effects in browser/native paths, and report variable conflicts explicitly.
The complete source Electron fixture also passes these browser boundaries.
Desktop shutdown now closes incomplete HTTP connections while draining accepted
responses and memory work; see [shutdown evidence](docs/desktop-shutdown.md).
Internal candidate `7d7eda18...` passes 24 newcomer/restart stages with native
macro fixtures, original Helper normal/quiet PromptViewer, script scopes and
persistence, and UI Git URL install/update. Six measured closes across the first
three suites stop all owned processes in about 0.86–0.94 seconds. These are
fixture results, not full compatibility certification; the official EXE is unchanged.
See [state boundaries](docs/native-macro-state.md) and test.md for evidence.
Direct world-info/extension-assembly lifecycle integration, browser callbacks in
native fields, remaining builtins and final release acceptance remain open.
The following candidate records describe earlier code until noted otherwise.

2026-10-02 public macro API update: `macro-system.js` and `MacroEnvBuilder.js`
now expose the real registry/engine and ordered live environment providers.
Legacy zero-argument bridges preserve call-specific names, dynamic values,
content, nonce and one-shot original state; postprocessing runs once. Character
fields resolve lazily and cache within each field snapshot. Source checks pass
351 tests, typechecking and build; the complete Electron plugin fixture passes.
Native macro writes/callbacks and complete builtin coverage are still open.
See test.md for the exact executable acceptance status; earlier candidates below
do not include this change. The official release has not been replaced.
Internal candidate `02d02d22...` passes 24 onboarding/restart stages including
the public macro fixtures, original Helper normal/quiet PromptViewer, scoped
scripts and persistence, and Git URL install/update. These checks do not prove
all Helper features under the new engine or complete Tavern compatibility.

2026-10-02 macro engine integration: the service and extension document now share
a standalone AGPL parser/registry adapted from pinned SillyTavern modules, using
Chevrotain 13.2.0. Parameterized/nested macros, typed arguments and lazy conditional
branches are available through the persisted experimental engine setting; existing
profiles retain the legacy default while remaining bindings are completed.
Native variable writes and browser callbacks in native card fields are still open.
Source checks pass 346 tests; the Electron fixture exercises native/browser parity
and durable browser variables. See [reuse assessment](docs/macro-engine-reuse.md).
This source is newer than the quiet candidate below; that EXE does not include it.

2026-10-02 current source: quiet generation now shares native SSE preflight,
request-scoped macro limits and final Token budgeting. Quiet previews do not
contact the provider or write chat. `skipWIAN` excludes world info and Author's
Note; structured output shares raw-generation JSON handling. End events carry
chat length and do not hold completion or cancellation behind extension listeners.
Source typechecking, 341 tests, build, the complete Electron plugin fixture and
the original Helper's quiet PromptViewer checks pass. The latter source run still
records external fetch/font resource errors; it is not an error-free release test.
Internal candidate `804e606dc1891e2e8dfb8b507a0e75c5fd55cc251189fbd0f6dbd5dc4f91c631`
passes 22 onboarding/restart stages, original Helper normal/quiet PromptViewer,
global/character/preset scripts and persistence, and Git URL installation/update.
Its corresponding source has 280 files and excludes Helper code and user data.
See [test.md](test.md) for evidence. The earlier EXE below does not contain these
changes; the official release remains unchanged pending full compatibility.

2026-10-02 previously verified native-preflight candidate:
`4a197a2a2557dbe8c3df30f99355c70ad6ab76a59e66ffa8d951f28608a7e822`.
Source checks pass 325 tests, typechecking/build and the complete Electron plugin
fixture. The same EXE passes 22 onboarding/restart stages, original Helper
PromptViewer (including hung-listener cancellation), script scope persistence,
and Git URL installation/update. Its 278-file corresponding source excludes
Helper code and user data. The official release remains unchanged. Full macro,
PromptManager and remaining generation/protocol compatibility are still open.
See [test.md](test.md) for evidence and retained failure reports.
The following entries describe pre-build implementation and earlier milestones.


Native preflight cancellation also releases a promise-returning listener that never settles; late rejections remain observed. The original Helper fixture verifies stop and a subsequent preview.

2026-10-02: Native chat now waits for extension prompt/settings events before
sending the model request. Normal/regenerate dry runs preserve chat, cancellation creates no
assistant placeholder or regeneration branch, and the final payload is counted
again without expanding macros twice. Native and extension requests share custom
body/header and proxy normalization. The original Helper's PromptViewer passes
actual open/refresh/expand and cancellation checks in source Electron. This is
newer than the scope candidate listed below; the official release is unchanged.
Quiet-mode dryRun remains explicitly unsupported and never starts a model request.


2026-10-02 scope/persistence update: Source typechecking, 305 tests and build
pass. Startup restores cannot replace a later story/character selection; stale
connection results cannot validate a newly saved connection. Unmodified Helper
character and preset scripts now pass scope switching, variable isolation,
pending-preset-write preservation, document reload and Helper re-enable.
Native settings and extension assembly accept the same 2,000,000-token context
ceiling. Candidate `2ff51b25a8d703c4b199c7662667a6d1ff855674b1f108bd13f6ad8d903db7af`
passes 22 packaged desktop stages, original Helper global/character/preset script
restart, and Git URL updates. The sole release EXE is still unchanged;
PromptViewer's native pre-request events and full compatibility remain open.
See [test.md](test.md) for exact evidence. Entries below are historical.

2026-10-02: The refactored source passes typechecking, 292 tests and the full
Electron extension fixture. Shutdown now drains background memory work before
closing SQLite; late chat responses cannot replace a different selected story.
The unmodified Helper's actual script iframe passes generation, variables,
slash commands, disable/re-enable, content updates and full-process restart.
Portable builds use a separate extraction directory for each launch.
Candidate `e920f343379c7cc4ba582befa7686ec70cc1072566e600e2963295bc3c72a653`
passes 22 desktop stages (including invalid-key/card recovery), Helper script
restart and Git URL updates. The sole release EXE is unchanged; complete Helper
compatibility remains unverified. Exact scope and reports are in [test.md](test.md).

MyCompanion is an open-source desktop AI roleplaying application designed for people who want to import a character card and start chatting without learning prompt engineering first. The supported product is the Windows desktop executable; no standalone browser deployment is provided.

The project is in active desktop development; the requirements include both implemented behavior and planned work. Product requirements are in [spec.md](spec.md), the verification plan is in [test.md](test.md), prior-art research is in [docs/open-source-research.md](docs/open-source-research.md), and the implementation comparison with SillyTavern 1.19.0 is in [docs/sillytavern-1.19-feature-gap.md](docs/sillytavern-1.19-feature-gap.md).

## Prerequisites

- Node.js 22.12 or newer
- npm 11 or newer

## Setup

```bash
npm install
npm run check
```

Build and run the desktop application:

```bash
npm run dev:desktop
```

Electron starts an internal service on a random loopback port. It is part of the desktop process boundary and has no standalone start command. Desktop data is stored in Electron's per-user application data directory.

## Workspace layout

```text
apps/
  desktop/           Electron shell and Windows packaging
  local-service/     Own database, model, memory and extension service
  renderer/          Own desktop workspace UI
packages/
  character-card/    Character Card V2/V3 validation and preview
  shared/            Shared API schemas and types
```

## Current milestone

2026-10-01 source update: Browser extension-prompt snapshots now carry an
explicit `macrosResolved` flag. Native preview, sending, helper assembly, and
world-info scanning preserve Tavern's single ordered macro pass; raw service
inputs still expand once. Typechecking, 274 tests, build, the Electron plugin
fixture, and an unchanged-Helper generation run pass. The frozen portable
candidate `9b4f7b3b48befa33d9d82e5721e1599fd12150da32504ce372600e655ef8a248`
passes 20 desktop stages, including the single-pass snapshot in the actual EXE;
unchanged-Helper and Git URL update checks also pass. The sole release EXE
still predates this change.

2026-10-01 source update: Browser world-info scans now use live global variables,
the selected model, and the response reserve. The service falls back to saved
settings for callers without a browser snapshot. Typechecking, 272 tests, build,
and the full Electron plugin fixture pass. An isolated portable candidate
(`40ba0425ae3f9b8bb035e02a472b51fb0ac0e03ff386d72ca2197aeb21055ddc`)
passes 19 packaged stages, including world-info budget/global-variable recovery
after restart, as well as unchanged Helper and Git URL update checks. The sole
release EXE still predates this update.
The source also handles the OpenRouter `OR_Website` no-model case in world-info
requests; the Electron plugin fixture passes, while the frozen candidate above
predates that final boundary fix.

2026-10-01 source update: Request-scoped context and response limits now feed
the same budget macros in native prompts, world-info matching, extension prompt
assembly, and quiet generation. The browser world-info request sends its response
reserve explicitly. The source check passes 271 tests; the unchanged Helper's
chat-override run matches native preview, assembled messages, and the provider
request with `maxPrompt`/`maxContext`/`maxResponse` in the prompt. This source is
not in the sole release EXE; full Helper and first-run acceptance remain open.
An isolated portable candidate with SHA-256
`d4b4c886f3ae2c2b8651e19b17a9da7c246a652f4ca6d262fb9da5eacde2f87a`
passes 17 packaged stages, including UI setup of a mock model and API key,
card import, first chat, and restart recovery. The unchanged Helper and
UI-driven Git URL install/update also pass their packaged checks. The sole
release EXE has not been replaced; full Helper behavior and remaining first-run
failure paths still need acceptance.

2026-10-01 current source: The untouched Tavern Helper 4.11.2 entry links against
all 28 required host modules with no missing named exports. An isolated Electron
run initializes its panel, completes non-streaming and streaming `generate` calls, persists
chat/global/slash variables and message edits through reload, deletes a message,
and survives disable/re-enable. Its actual text-generation request now matches
native preview messages and token budget for card fixtures with both full-width
and ASCII example separators. Long slash-command help now saves without
truncation. Re-entering the same Git URL updates an extension while retaining
its enabled state and contributions; a local Git smart-HTTP fixture checks this
path. Saved chat-level scenario, system-prompt and example overrides use the
same native/helper assembly and provider messages in the isolated original-helper
check. The single-file candidate passed UI-driven URL install and update without
system Git, 17 packaged desktop stages, and a two-launch original-helper
generation and variable recovery check. Native prompts and world-info matching
now read saved chat/global variables through the same read-only macro contract;
the original-helper check verifies those values in the actual provider request.
The streaming helper check also verifies assembled prompts and configured stop
strings against a two-event SSE provider response.
Separate original-helper runs now verify normal streaming, user stop and an
upstream disconnect after the first SSE event. Both failure paths release the
generation controls and leave the chat unchanged. Native prompt assembly now
expands saved character-field variables before world-info scanning and counts
the final one-pass macro and command text before sending it. The source check
passes 267 tests. Native and extension date macros now share localized/ISO
formatting; the untouched helper's dated chat override matches the native
preview and provider request. The packaged candidate and sole release EXE
predate these changes.
An isolated Electron 44.4.4 portable candidate now passes 17 desktop stages,
the unchanged Helper's two-launch recovery check and UI-driven Git URL update.
The earlier sandbox bootstrap console errors are absent in that candidate.
The official release file is unchanged while full compatibility and first-run
acceptance remain open.
These scenarios are not full helper acceptance. The sole release EXE remains
the older 0.2.1 binary.

The dated entries below describe earlier milestones and retain their original
test boundaries.

2026-10-01: All 28 host modules imported by the untouched Tavern Helper 4.11.2
entry are now served. The new modules provide real favorite-character shortcuts
in the desktop sidebar, mobile-layout detection, solo/group-name lookup, and a
catalog backed by registered macros. Parameterized new-engine macros and group
chats remain incomplete and reject unsupported use. Static linking still fails
on 3 OpenAI prompt-manager exports; the helper has not initialized end to end.
The full Electron plugin fixture passes, and the sole release EXE is unchanged.

2026-10-01: The independent desktop now exposes the real Chat Completion
`main_api`, releases the actual generation controls through
`showSwipeButtons`, and publishes `online_status`/`connectedToApi` only after
an observed successful provider test or request. Saving provider settings
resets that status until the new connection is checked. The full Electron
plugin fixture and 255 source tests pass. The untouched helper's static audit
still lacks 3 modules and 3 exports; no new release EXE has been published.

2026-10-01: The browser compatibility API now cleans generated text through
the actual output-regex, stop-string, name, and formatting settings used by
the original helper's streaming calls. `/script.js` also exports the live
persona avatar binding. Loading that module exposed and fixed a reload bug:
manual persona descriptions without an avatar are now preserved. The full
Electron plugin fixture passes; the untouched helper still lacks 3 modules
and 6 exports. The sole published EXE has not been replaced.

2026-10-01: The browser compatibility API now converts real chat history and
dialogue examples into the message arrays used by the original helper. It
preserves newest-first order, narrator roles, ignored messages, and model-bound
reasoning/tool signatures. The real Electron document verifies these mappings;
the untouched helper's import audit is down to 3 missing modules and 8 missing
exports. It still cannot initialize end to end, and the sole published EXE has
not been replaced.

2026-10-01: Persona avatar upload/list/delete now uses the application's own
SQLite store and the Tavern-compatible `/api/avatars/*` and `User Avatars`
paths. Selection persists in `power_user`; the selected name and description
feed native prompt assembly, including chat-locked personas. Avatar bytes and
settings survive restart and backup/restore. The real Electron document passed
upload, selection, prompt and reload checks. The untouched Tavern Helper still
fails static import audit (3 missing modules, 20 missing exports); the sole
published EXE has not been replaced.

2026-10-01: Worldbook entries at the positions before and after Author's Note
now surround the note in actual model messages whenever its interval is active.
When inactive they leave both the prompt and Token budget. Persistent
`power_user` settings now feed persona description into native preview, normal
generation and quiet generation at its configured position/depth; the browser
module reloads the same settings for extensions. The original Tavern Helper
still fails static import audit (4 missing modules, 22 missing exports), so
this is not a full compatibility or release acceptance result.

2026-10-01: Author's Note now reads persisted chat metadata and extension defaults
through one project-owned rule shared by native prompt assembly and the browser
compatibility module. Preview, ordinary generation and quiet generation use the
same interval/placement decision; worldbook scanning sees eligible note text.
The interval uses the full active branch's user-turn count, including a preview
draft, rather than the last 80 model-context messages. The real Electron
document and native preview were checked. The single-user desktop profile
exposes its owner role through the extension `isAdmin()` contract. The untouched Tavern Helper still
fails static import audit (5 missing modules and 22 missing exports at that milestone); the sole
published EXE remains older than current source.

2026-10-01: Browser slash commands now execute from the real composer or
programmatically, return `pipe`/error results, and persist local/global
variables through the existing chat/settings stores. Registered aliases,
named arguments and the helper's boolean enum/argument modules are available.
Unknown commands retain the draft and never become model input. The original
Tavern Helper static import audit is still failing (7 missing modules and 22
missing exports); the full Tavern parser, closures and command catalog remain
unfinished. The sole published EXE remains older than this source milestone.

2026-10-01: `generateQuietPrompt` now uses the selected story's native prompt,
worldbook, memory, regex and model path without writing a chat turn or changing
the saved token limit. The exported `Generate` entry routes ordinary sends and
regeneration through the real React/SSE conversation workflow. Unsupported
quiet media, group override, structured output and other unimplemented modes
reject explicitly. The untouched Tavern Helper still cannot initialize:
its static audit reports 10 missing host modules and 22 missing exports.
These source changes are absent from the sole published EXE.

As of 2026-10-01, native chat and the extension token-count endpoint use the same
model-selected BPE tables and request-message framing estimate. The final request
is counted after macro expansion and injection; optional worldbook entries and
older messages are trimmed when needed. If fixed prompts plus the latest input
still exceed the configured context limit, generation stops before the provider
request. Tavern-style `{{random::a::b}}` and `{{random:a,b}}` now run in both the
native and extension paths. The original Tavern Helper 4.11.2 still fails its
static import audit (10 missing host modules, 23 missing exports); passing our
Electron fixtures is not full helper compatibility. The sole EXE in `release/`
predates these source changes.

The active requirement is **complete Tavern Helper compatibility through independent
implementation**. The desktop now starts this project's React UI and Fastify/SQLite
service. It does not start or embed the SillyTavern application. Default builds and
packaging use only this independent implementation. The previous embedded Tavern
engine, standalone Node runtime and their build paths have been removed.

The existing character-card, chat, branching, model, memory and extension code is
being extended into a real compatibility layer. All 28 modules needed by the
original helper entry now link, and one non-streaming generation succeeds in an
isolated Electron run. The unverified behavior of the remaining APIs means full
compatibility has **not** been achieved. The project's Electron fixtures are not
full helper acceptance.
See [the independent implementation requirements](docs/independent-helper-architecture.md).

Legacy registered macros and local/global variables now run in the actual
extension document. Raw model requests, extension prompt snapshots and regex
substitutions share that runtime; variable writes use the existing chat/settings
queues and survive story switches and reloads. The experimental nested macro
engine, card/group/instruct/date/random macros and full native macro unification
remain unfinished. Registered browser callbacks are not serialized to the server.

Named chat-completion presets now have a real settings-page selector, JSON
import/export, save, rename and delete. Extensions use the same live lists and
selection; switching applies sampling parameters to actual model requests.
Connection fields change only when binding is enabled. Prompt definitions and
unknown extension data are retained, but complete PromptManager assembly and the
original helper runtime remain unfinished. Presets use the existing SQLite
backup domain; general extension-settings saves cannot erase newer preset writes.

Regex execution now shares one independent core across extension calls, actual
message formatting and native input/prompt/output processing. Scope priority,
destination flags, depths, edit flags, captures, trimming and basic find macros
are supported. Prompt/display transformations do not overwrite stored messages.
Native workers are cancellable; extension APIs retain synchronous Tavern behavior.
Character extension-field writes now persist against the latest card instead of
returning empty success. Full macros and all automatic world-info/reasoning/slash
processing points remain unfinished.

Real jQuery/DOMPurify/Lodash/Popper/Toastr, helper utility functions and SSE parsing
now replace part of the old placeholder layer. Extension settings are shared and
persisted in SQLite, including backup/restore. The browser verification uses
project-authored fixtures; its primitive, chat, persistence and rendering
checks are not an original-helper pass. Extensions now run in the actual React
document, sharing libraries, settings and events. Chat selectors refer to the
visible messages and composer. Enable/disable/uninstall flush settings and reload
the document, retaining the current story and draft.
Chat save/metadata/reload APIs now reach the actual SQLite messages and metadata,
preserving extension variables through generation, branching, backup and reload.
Slow saves preserve newer unsaved edits; debounced writes retain their story target.
Application messages and extension formatting share markdown-it and DOMPurify;
display-only replacements keep the raw model text intact. The full Tavern
formatting pipeline, media/reasoning rendering and swipe behavior remain unfinished.
The served reasoning module extracts provider-specific thought text from response
data; this does not establish full streaming/generation compatibility.
Generation controls now operate the actual composer and cancellation path.
Extension busy UI remains distinct from native generation; stop/progress APIs,
delegated extension cancellation and persisted partial native replies are tested.
Stable send/stop nodes prevent a stop handler from accidentally submitting a draft.
Generate, the OpenAI module and complete swipe behavior remain unfinished.
Temporary extension prompts now keep their live registry, insertion positions,
depths, roles, scan flags and async filters. Native send, regeneration and preview
take request snapshots and account for injection tokens before history trimming.
Scan-only prompts can activate worldbooks without entering model messages.
Story changes/reloads clear temporary injections; filter failures retain the
unsent draft and prevent model/chat writes. Full preset overrides and macros
remain unfinished.
Extension templates now use shared Handlebars compilation, sanitization and
locale catalogs. Native modal dialogs implement confirmation, text input,
custom controls, close hooks, nested focus and CropperJS image cropping. Shared
library imports await initialization, including when the host is imported early.
Named worldbooks now persist in the application's SQLite database, participate
in backup/restore and feed real generation/preview through global, character and
chat bindings. Card and named books share secondary-key matching, scan depth,
recursion and budget logic, with character/example/depth insertion positions.
The world-info browser module now shares actual settings and documents with an
independent React editor. Per-book save queues, debounce, deletion, error recovery,
prompt result shapes and reload persistence are exercised in Electron. Advanced
effects and the complete helper call chain remain unfinished.
Character create/edit/get/list and chat-history endpoints now read and write the
same SQLite cards used by generation, export and backup. Multipart fields preserve
V2/V3 metadata and extension variables. Stable avatar identifiers survive renaming
and restoration. Extensions see complete character records and a numeric current
index; refresh updates the actual sidebar while retaining unsaved extension fields.
Out-of-order reads cannot revert newer refreshes. Full document reload now retains
the current story/character and draft. The actual character editor now shares its
form with extensions, including primary worldbook selection, alternate greetings,
PNG uploads and the hidden raw-card snapshot. Debounced saves retain their avatar;
save events can await another save without deadlocking. Scripted selection preserves
per-role drafts, retries failed writes, and cannot supersede newer user navigation
or chat edits. Saving a character now rebuilds its unused greeting through actual
message events, rendering and SQLite persistence, including alternate greetings
and output rules. Used/edited histories and newer local edits remain protected.
Initial-story greeting unification, complete swipe controls, non-PNG avatar
conversion and cropping still need implementation.
Complete extension documents submitted without `json_data` replace extensions,
so deleted variables stay deleted; documents submitted with a snapshot merge into
that snapshot. An empty world selector preserves an already-unbound embedded book.
Desktop startup now binds a random high loopback port, retrying occupied/excluded
ports, after verification exposed an OS-assigned port blocked by Chromium.
`deleteCharacter` now supports single/batch deletion and the helper's `deleteChats`
option. Deletion removes the actual card and releases its avatar filename. Kept
histories live in a separate SQLite table and reattach when that filename is reused,
including branches, message variables, metadata, generation settings, memories and
summaries. They survive database restart and full backup/restore; conflicting
identities are rejected before restore. Real UI cleanup, deletion events, failures
and stale reads are exercised in Electron. This is separate from the existing
application recycle-bin API.
The frozen candidate-independent-03 portable EXE passed 15 functional stages, with 27 utility
checks in each startup/restart phase; packaged library/license inspection also
passed. Captured Electron internal sandbox console errors still need diagnosis.
Historical portable-build reports were removed during output cleanup; the current
verification records are listed in `test.md`. Reports now live in `.cache/reports/`,
and verification scripts use that directory by default so `output/` stays empty.
This is not complete release acceptance.
That frozen EXE predates the main-document migration, chat persistence and message
rendering changes described above. Renderer builds now emit dependency license
texts in `THIRD_PARTY_LICENSES.md`, which packaging requires alongside the UI.

The old embedded-engine candidates and their raw output reports have been deleted.
Their results are described in the historical documents and do not establish independent compatibility.
[Historical milestone details](docs/embedded-engine-milestone-history.md) are kept
separate. The single official release has not been replaced.

At that earlier milestone, the source passed 237 unit/component tests and 195
Electron fixture stages. The internal unpacked desktop build passed 17 startup,
chat, persistence and shutdown stages, with 28 utility checks per run. Two
Electron sandbox initialization console errors remain recorded; this is not
full helper or portable-release acceptance. That binary predates the named
worldbook, character and message-surface changes. See `test.md` for the exact reports.

Run the original-helper import inventory with a separately obtained checkout:

```bash
node apps/desktop/scripts/audit-independent-helper.mjs --helper <path>
```

The former reference-engine build, preparation and verification commands have
been removed. Separately obtained upstream research checkouts remain outside
the application and source archive. To verify an independent executable, use
`npm run verify:packaged -- --exe <path> --report-label <label>`.

## Windows executable

Build a portable Windows x64 executable with:

```bash
npm run package:win
```

The artifact is written to `release/MyCompanion-<version>-windows-x64.exe`. It contains the project's own UI/service, Electron, corresponding source and license notices. It listens only on a random `127.0.0.1` port while the app runs. This independent candidate still needs full helper and release acceptance; the existing official EXE remains unchanged. Development builds are unsigned.

Packaging excludes workspace data, fixtures and local database files. An `afterPack` check rejects archives that still contain them. Local SQLite files are retained in the workspace; packaging never deletes user data.

## License status

MyCompanion remains [AGPL-3.0-only](LICENSE). Runtime libraries retain their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). `npm run prepare:source`
prepares this project's corresponding source for the independent package.

SillyTavern and the previous integrated engine are reference-only. Their existing
attributions, source snapshots and modification records remain in the repository;
they are not packaged or started by the default application. Tavern Helper has a
separate PolyForm Noncommercial 1.0.0 license and is never bundled in application
or source archives. Independent implementation does not change its license.

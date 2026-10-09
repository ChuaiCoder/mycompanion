# Third-party notices

MyCompanion is licensed under `AGPL-3.0-only`. This file records the main
third-party software used to build and run the independent application.
MyCompanion is a standalone character-chat application: it does not embed,
run or distribute the complete SillyTavern application, and it has no
third-party extension or helper compatibility host (removed 2026-10-03).
Reference-only inputs and old candidates retain their original notices and
provenance. Each component remains subject to its own license.

## Runtime and packaged components

| Component | Version | License | Purpose |
| --- | ---: | --- | --- |
| React / React DOM | 19.3.0 | MIT | Desktop Renderer interface |
| i18next / react-i18next | 26.4.2 / 17.0.15 | MIT | Persistent desktop language selection; © 2011-present / 2015-present i18next; full texts in renderer/THIRD_PARTY_LICENSES.md |
| Fastify | 5.12.5 | MIT | Loopback-only local service |
| @fastify/static | 10.1.4 | MIT | Bundled Renderer assets |
| @fastify/multipart | 10.1.2 | MIT | Streaming multipart character forms; © Fastify team |
| @fastify/deepmerge | 3.2.1 | MIT | Character extension-object merge with replacement arrays; © Fastify team |
| Zod | 4.6.5 | MIT | Runtime schema validation |
| png-chunk-text | 1.0.0 | MIT | PNG text metadata encoding |
| png-chunks-extract | 1.0.0 | MIT | PNG chunk parsing |
| Electron | 44.4.4 | MIT | Windows desktop shell |
| yauzl | 3.4.0 | MIT | Bounded, lazy ZIP inspection for local character archives |
| yazl | 3.3.1 | MIT | Byte-preserving CHARX archive output; © 2014 Josh Wolfe; package LICENSE retained |
| yaml | 2.9.1 | ISC | YAML parsing for legacy character import and request building; © Eemeli Aro; package LICENSE retained |
| DOMPurify | 3.4.16 | Apache-2.0 (chosen from Apache-2.0 OR MPL-2.0) | HTML sanitization |
| markdown-it | 15.0.2 | MIT | Message Markdown rendering |
| eventsource-parser | 4.1.1 | MIT | SSE parsing; project-owned MessageEvent/TransformStream adapter |
| gpt-tokenizer | 4.0.0 | MIT | Local BPE token counting; © 2023–2024 Bazyli Brzoska; package LICENSE retained |
| image-size header excerpts | e6e83a55 | MIT | Fixed, unchanged PNG/JPEG/GIF/WebP handlers and utilities; © 2013-Present Aditya Yadav; import/compiler adapters only; full license below |
| sanitize-filename | 1.6.3 | MIT | Filename compatibility endpoint |

Browser library/font files are served unchanged from pinned dependencies, without
copying the Tavern application. Package license texts remain with their dependencies.
Renderer-bundled dependencies, including markdown-it, DOMPurify, entities
(BSD-2-Clause), linkify-it, mdurl, punycode.js and uc.micro (MIT), are accompanied
by their full license texts in `renderer/THIRD_PARTY_LICENSES.md`. Vite generates
this file from the actual build inputs; the desktop packaging gate requires it.
`getStringHash` reuses bryc's 2018 cyrb53 algorithm under its public-domain/MIT
grant: https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js.
Attribution is retained in `apps/local-service/src/world-info-upstream-runtime.ts`
and the world-info vector modules.

## Reused world-info scanner and effects

The world-info vector activation/query selection excerpts (`getQueryText`,
`activateWorldInfo`, `multiQueryCollection`) are adapted from
`public/scripts/extensions/vectors/index.js` and `src/endpoints/vectors.js` at the
fixed SillyTavern 1.19.0 commit below, under AGPL-3.0-only, copyright SillyTavern
contributors. `apps/local-service/world-info-vector-upstream.json` records the
original hashes, generated hash and invocation-specific adapters;
`scripts/import-world-info-vectors.mjs` generates the editable excerpt. The full
upstream server, application and extension are not bundled.

WorldInfoBuffer, WorldInfoTimedEffects, group scoring/weighted selection,
decorator parsing and the scan loop are adapted from the same fixed SillyTavern
1.19.0 commit under AGPL-3.0-only, copyright SillyTavern contributors.
`apps/local-service/world-info-upstream.json` records source and adapted hashes;
`scripts/import-world-info-upstream.mjs` is the editable generation source.
Invocation-local dependencies use MyCompanion's existing macro/tokenizer and
SQLite chat metadata. Empty timer normalization does not create durable state;
real effects use accepted-request transactions and branch-prefix checkpoints.
An idempotent group removal repairs upstream's overlapping-group `splice(-1)`
deletion. Explicit extension scan text remains eligible at zero chat depth.
These modifications are recorded and compared with genuine upstream output.
The full AGPL text is in LICENSE; the generated source preserves bryc's cyrb53
attribution. This reuse does not embed the complete Tavern application.

## Reused prompt and CHARX components

The Claude/Gemini message conversion and reasoning-budget declarations are
adapted from `src/prompt-converters.js` at the same fixed SillyTavern commit,
under AGPL-3.0-only, copyright SillyTavern contributors. Original declaration
and generated hashes, including the explicit signed `provider_native` replay
adaptation, are in `apps/local-service/provider-converters-upstream.json`;
`scripts/import-provider-converters.mjs` verifies or regenerates those sources.

Selected PromptManager and text-only chat-completion preparation/population
functions are adapted from SillyTavern 1.19.0 at
`7e8663cd9c184a550b37238218bdd32c6efc68e9`, copyright SillyTavern
contributors, AGPL-3.0-only. The typed host adapters, changed behavior and
original declaration hashes are recorded in
`apps/local-service/prompt-manager-upstream.json`. The four exact
`src/fixtures/prompt-*-upstream-reference.json` files are fixed-upstream
execution outputs from project regression scenarios, with source hashes.
They contain no installed Helper or user content.

CHARX embedded-URI resolution, archive prefix handling and main icon selection
are adapted from the same upstream `src/charx.js` under AGPL-3.0-only.
Legacy V1/Pygmalion and YAML field mappings are adapted from its
`src/endpoints/characters.js` import and conversion functions. Original hashes
and host adaptations appear in `apps/local-service/character-assets-upstream.json`.
PNG asset chunk processing is project-authored code using the existing MIT PNG
libraries and the pinned MIT Character Card V3 specification; RisuAI is a
reference-only comparison. No RisuAI source is redistributed.
MyCompanion stores all auxiliary asset bytes in the same SQLite transactions
as the card and full backup, rather than copying upstream's filesystem storage.
`apps/local-service/character-assets-upstream.json` records the reviewed inputs,
hashes and modifications. RisuAI's implementation and the Character Card V3
specification were compared as reference; no RisuAI code is copied.

Electron packages Chromium and Node.js. Their license files and Chromium's
third-party notice bundle are included by the Electron distribution inside the
packaged application.

## MIT License — Backyard AI BYAF schema definitions

The pinned `backyardai/byaf` schema definitions are included in editable source
and compiled by the service under MIT. Copyright and full license follow.
Fixed source and modifications are recorded in `apps/local-service/byaf-upstream.json`.
Selected `src/byaf.js` conversion methods come from the fixed SillyTavern
commit above under AGPL-3.0-only; bounded archive and SQLite host adapters are
MyCompanion changes. No upstream default image or complete application is shipped.

Copyright (c) 2025 Ahoy Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## MIT License — Vectra vector metric methods

Three unmodified `ItemSelector` method declarations are included from Vectra
commit `dec2dadc3bb158b06ac72fa9097bee729429a271` in
`apps/local-service/src/vector-metric-upstream.ts`. The surrounding class is
renamed; the host validates dimensions and values. Source hashes and changes
are in `apps/local-service/vector-upstream.json`; the editable importer is
`scripts/import-vector-upstream.mjs`. No complete Vectra index/NLP stack is bundled.

Copyright (c) 2023-2026 Steven Ickman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Build and test tools

The project also uses TypeScript 7.0.2 (Apache-2.0), esbuild 0.28.2 (MIT),
Vite 8.3.0 (MIT), Vitest 5.0.1 (MIT), jsdom 30.1.0 (MIT), tsx 4.23.13 (MIT),
electron-builder 26.15.3 (MIT), es-module-lexer 2.3.2 (MIT, import/export inventory),
and Testing Library packages (MIT). Acorn 8.18.0 (MIT, copyright 2012–2022
various contributors) is used only by the upstream-source research importers
and is not injected into the application runtime.
`tar` 7.5.22 (BlueOak-1.0.0) is a development-only corresponding-source
archive inspection dependency. Its full license remains in its npm package.

The exact transitive dependency versions are locked in `package-lock.json`.
This summary does not replace the license texts distributed with those
packages.

## Compatibility research

SillyTavern 1.19.0 (`7e8663cd9c184a550b37238218bdd32c6efc68e9`, AGPL-3.0)
was embedded in historical internal candidates. That implementation and its
candidates have been removed, including generated `vendor/sillytavern`, the
migration converter, preparation scripts and the separate Node 24.18.0 runtime.
Historical integrations used Node (MIT and bundled notices), isomorphic-git
1.37.2 (MIT) and js-sha256 0.11.1 (MIT); those integrations are no longer shipped
or built. Historical attribution and reports remain in the project's internal source-tracking records.
Separately obtained upstream research checkouts retain their original licenses
and are excluded from application and source packaging. Electron still includes
its own Node runtime.

RisuAI (GPL-3.0), Agnai (AGPL-3.0) and TauriTavern (AGPL-3.0) were re-reviewed
for the independent architecture. No source from those projects was copied.
Pinned revisions and the evaluation are recorded in the project's internal
source-tracking and research records.

DeepWrite remains prior art only; no DeepWrite code, templates, styles, media
or branding are included. The inspected revisions are recorded internally.

JS-Slash-Runner (酒馆助手) was also inspected to identify extension API gaps.
It is licensed under PolyForm Noncommercial 1.0.0 and is not bundled or
redistributed with MyCompanion. Its license does not become AGPL through
installation or interoperability.

## MIT License — image-size header excerpts

Fixed source: https://codeberg.org/image-size/image-size/src/commit/e6e83a5578961de81f6d5834d90fb7430d8f29a5/lib/types
Only PNG/JPEG/GIF/WebP handlers, types and utilities are reused. Generic detection and other format handlers are excluded. Import specifiers and compiler directives are adapted; function bodies remain unchanged. Source and output hashes are in apps/local-service/image-headers-upstream.json.

The MIT License (MIT)

Copyright © 2013-Present Aditya Yadav, http://netroy.in

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

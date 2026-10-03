# Third-party notices

MyCompanion is licensed under `AGPL-3.0-only`. This file records the main
third-party software used to build and run the independent application. The
2026-09-30 requirement excludes embedding the complete Tavern application.
Reference-only inputs and old candidates retain their original notices and
provenance. Each component remains subject to its own license.

## Reused macro parser and registry

The standalone `@mycompanion/macro-engine` package contains adapted SillyTavern
1.19.0 macro lexer/parser/walker/registry/engine/flags/environment builder and selected utility,
conditional, character and world-info/Outlet environment definitions, copyright SillyTavern contributors, licensed under
AGPL-3.0-only. Original source: https://github.com/SillyTavern/SillyTavern/tree/7e8663cd9c184a550b37238218bdd32c6efc68e9/public/scripts/macros
The full AGPL text accompanies this application in LICENSE. File hashes and
adaptations are listed in `packages/macro-engine/upstream.json` and its README.
This reuses a parsing component; it does not run the complete Tavern application.

Chevrotain and @chevrotain/{gast,types,utils,cst-dts-gen,regexp-to-ast} 13.2.0
are bundled in the macro module under Apache-2.0. Their complete license appears
below and their npm packages retain their original license notices.
The `getStringHash` excerpt retains cyrb53 attribution: (c) 2018 bryc,
public domain (or MIT if needed), https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js.

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
| yauzl | 3.4.0 | MIT | Bounded, lazy ZIP inspection for local extension packages |
| yazl | 3.3.1 | MIT | Byte-preserving CHARX archive output; © 2014 Josh Wolfe; package LICENSE retained |
| isomorphic-git | 1.42.2 | MIT | Own service's extension URL installation |
| jQuery | 3.7.1 | MIT | Extension DOM/events/AJAX compatibility; unmodified npm browser build |
| Lodash | 4.18.1 | MIT | Extension utilities and templates |
| Handlebars | 4.7.9 | MIT | Extension HTML template compilation and helpers; © Yehuda Katz |
| CropperJS | 1.6.2 | MIT | Interactive popup image cropping; © Chen Fengyuan |
| DOMPurify | 3.4.16 | Apache-2.0 (chosen from Apache-2.0 OR MPL-2.0) | Actual HTML sanitization API |
| markdown-it | 15.0.2 | MIT | Shared application/extension message rendering |
| @popperjs/core | 2.11.8 | MIT | Extension floating element positioning |
| Toastr | 2.1.4 | MIT | Extension notifications |
| @highlightjs/cdn-assets | 11.12.0 | BSD-3-Clause | Locally bundled Highlight.js browser build for extension code highlighting; © 2006 Ivan Sagalaev; package LICENSE retained |
| eventsource-parser | 4.1.1 | MIT | SSE parsing; project-owned MessageEvent/TransformStream adapter |
| gpt-tokenizer | 4.0.0 | MIT | Local BPE counting for extension prompt/message budgets; © 2023–2024 Bazyli Brzoska; package LICENSE retained |
| image-size header excerpts | e6e83a55 | MIT | Fixed, unchanged PNG/JPEG/GIF/WebP handlers and utilities; © 2013-Present Aditya Yadav; import/compiler adapters only; full license below |
| yaml | 2.9.1 | ISC | Extension custom request body/header YAML parsing; © Eemeli Aro; package LICENSE retained |
| sanitize-filename | 1.6.3 | MIT | Filename compatibility endpoint |
| Font Awesome Free | 6.7.2 | MIT (code), OFL-1.1 (fonts), CC-BY-4.0 (icons) | Extension icons and picker; © Fonticons, Inc.; https://fontawesome.com |

Browser library/font files are served unchanged from pinned dependencies, without
copying the Tavern application. The icon-name catalog is derived from Font Awesome
metadata. Package license texts remain with their dependencies; Toastr's npm
distribution only links its MIT license, so its full notice is reproduced below.
Renderer-bundled dependencies, including markdown-it, DOMPurify, entities
(BSD-2-Clause), linkify-it, mdurl, punycode.js and uc.micro (MIT), are accompanied
by their full license texts in `renderer/THIRD_PARTY_LICENSES.md`. Vite generates
this file from the actual build inputs; the desktop packaging gate requires it.
`getStringHash` reuses bryc's 2018 cyrb53 algorithm under its public-domain/MIT
grant: https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js.
Attribution is retained in `plugin-runtime-utils.ts`.

## Reused world-info scanner and effects

`public/scripts/tool-calling.js` from the same fixed SillyTavern commit is served
as one unchanged browser module, including ToolDefinition, ToolManager and its
tool slash commands, under AGPL-3.0-only, copyright SillyTavern contributors.
`apps/local-service/tool-calling-upstream.json` records both source/output hashes;
`scripts/import-tool-calling.mjs` verifies or regenerates the module. The host
effect/cancellation/continuation adapters are separate project-authored code.

The world-info vector activation/query selection excerpts (`getQueryText`,
`activateWorldInfo`, `multiQueryCollection`) are adapted from
`public/scripts/extensions/vectors/index.js` and `src/endpoints/vectors.js` at the
same fixed SillyTavern commit below, under AGPL-3.0-only, copyright SillyTavern
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

## Reused prompt, Slash and CHARX components

The Claude/Gemini message conversion and reasoning-budget declarations are
adapted from `src/prompt-converters.js` at the same fixed SillyTavern commit,
under AGPL-3.0-only, copyright SillyTavern contributors. Original declaration
and generated hashes, including the explicit signed `provider_native` replay
adaptation, are in `apps/local-service/provider-converters-upstream.json`;
`scripts/import-provider-converters.mjs` verifies or regenerates those sources.

The selected Quick Reply execution definitions (AutoExecuteHandler, QuickReply,
QuickReplySet execution/defaults, loadSets and executeQuickReplyByName) are
adapted from that fixed commit's `public/scripts/extensions/quick-reply/` under
AGPL-3.0-only, copyright SillyTavern contributors. Original file hashes and
execution-only changes are recorded in `apps/local-service/quick-reply-upstream.json`
and its generator. The complete upstream editor and application are not bundled.

Selected PromptManager and text-only chat-completion preparation/population
functions are adapted from SillyTavern 1.19.0 at
`7e8663cd9c184a550b37238218bdd32c6efc68e9`, copyright SillyTavern
contributors, AGPL-3.0-only. The typed host adapters, changed behavior and
original declaration hashes are recorded in
`apps/local-service/prompt-manager-upstream.json`. The four exact
`src/fixtures/prompt-*-upstream-reference.json` files are fixed-upstream
execution outputs from project regression scenarios, with source hashes.
They contain no installed Helper or user content.

The same fixed upstream supplies 24 selected Slash execution, variable,
utility and return-dispatch modules in `apps/local-service/upstream-slash`.
Each file has a modification notice; original and adapted hashes and the
specific changes appear in `apps/local-service/slash-upstream.json`.
`scripts/import-slash-upstream.mjs` is the preferred generation source.
The original `/input` (alias `/prompt`), `/popup` and `/buttons` registrations
and callback text are preserved. A per-invocation dependency factory binds
them to the native Popup and cancellable delay; this host adaptation and its
desktop-theme button styles do not distribute the Tavern document or stylesheets.
The readable modules and generated TypeScript asset map are included in
corresponding source. Regeneration takes a separately obtained fixed upstream
checkout; ordinary installation, tests and builds do not need the research cache.
Acorn 8.18.0 (MIT, copyright 2012–2022 various contributors) is used only
by this build/research importer and is not injected into the application runtime.

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
and Testing Library packages (MIT).
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
or built. Historical attribution and reports remain in `docs/source-tracking.md`.
Separately obtained upstream research checkouts retain their original licenses
and are excluded from application and source packaging. Electron still includes
its own Node runtime.

RisuAI (GPL-3.0), Agnai (AGPL-3.0) and TauriTavern (AGPL-3.0) were re-reviewed
for the independent architecture. No source from those projects was copied.
Pinned revisions and the evaluation are in `docs/independent-helper-architecture.md`.

DeepWrite remains prior art only; no DeepWrite code, templates, styles, media
or branding are included. See `docs/source-tracking.md` for the revisions.

JS-Slash-Runner (酒馆助手) was also inspected to identify extension API gaps.
It is licensed under PolyForm Noncommercial 1.0.0 and is not bundled or
redistributed with MyCompanion. Its license does not become AGPL through
installation or interoperability.

## MIT License — Toastr 2.1.4

Toastr. Copyright 2012–2015. Authors: John Papa, Hans Fjällemark, and Tim Ferrell.
The upstream JavaScript header specifies the MIT license at
http://www.opensource.org/licenses/mit-license.php.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.


## Apache-2.0 — Chevrotain 13.2.0 and its component packages


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.


## MIT License — image-size header excerpts

Fixed source: https://codeberg.org/image-size/image-size/src/commit/e6e83a5578961de81f6d5834d90fb7430d8f29a5/lib/types
Only PNG/JPEG/GIF/WebP handlers, types and utilities are reused. Generic detection and other format handlers are excluded. Import specifiers and compiler directives are adapted; function bodies remain unchanged. Source and output hashes are in apps/local-service/image-headers-upstream.json.

The MIT License (MIT)

Copyright © 2013-Present Aditya Yadav, http://netroy.in

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

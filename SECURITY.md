# Security policy

Please report a suspected vulnerability privately to the project maintainer
before opening a public issue. Until a public security contact is configured,
do not include API keys, private character cards, chat logs, or exploit payloads
in a public report.

Supported releases and a dedicated security contact will be published before
the first public release. Character-card samples used in reports should be
reduced to the minimum data needed to reproduce the issue.

The third-party extension runtime was removed on 2026-10-03. The application no
longer installs, loads or executes third-party JavaScript or CSS, provides no
Git/ZIP extension installation, no Tampermonkey-style helper host, and no
extension DOM or same-origin API surface. The renderer loads only its own
bundled assets.

The only extension mechanism is a declarative, data-only plugin manifest
(`pluginManifestSchema`: a system-prompt contribution and a command list, with
declared `prompt:system` / `command:register` permissions). It carries no code
and is validated on the service before storage.

Electron enables process sandboxing and context isolation and disables Node
integration, with no preload script, no contextBridge and no IPC channel: the
renderer reaches the service only over same-origin HTTP and SSE on a loopback
port, and all imported files are re-validated by the local service rather than
trusted from the renderer. Secrets are encrypted at rest through Electron
`safeStorage` and are never returned to the renderer.

Escaping the Electron process boundary, bypassing filesystem path checks during
import or asset access, exposing secrets through unintended API responses, or
executing scripts through ordinary sanitized content are security issues.
Report them privately.
